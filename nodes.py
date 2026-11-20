"""huan 素材浏览器 (huan_AssetBrowser) for ComfyUI.

Cross-platform implementation (Windows / Linux / macOS) of the embedded asset
browser node, written against ComfyUI's classic node API so it works with
ComfyUI 0.3.x (including 0.3.41) on Python 3.10 - 3.13.

The node embeds the local asset browser HTML in a DOM widget.  Images chosen in
the browser are uploaded to ComfyUI's input directory (the upload itself is
local) and the node returns all chosen images as one IMAGE batch.

ComfyUI's own PreviewImage node automatically slices this batch when several
PreviewImage nodes are connected to the same huan_AssetBrowser output.  The
patch is deliberately scoped to previews whose direct input comes from this
plugin; all other PreviewImage usage keeps ComfyUI's normal behavior.
"""

from __future__ import annotations

import inspect
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import PurePosixPath

import numpy as np
import torch
from PIL import Image, ImageOps

try:
    import folder_paths
except Exception:  # pragma: no cover - allows importing outside ComfyUI
    folder_paths = None

try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # pragma: no cover - only used inside ComfyUI
    PromptServer = None
    web = None


__version__ = "1.3.0"

IS_WINDOWS = os.name == "nt"
UPLOAD_ROOT_NAME = "huan_asset_browser"
SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
MAX_UPLOAD_FILES = 300

# Linux/macOS limit a single path component to NAME_MAX bytes (255 on ext4,
# 255 on APFS, 255 on XFS).  Windows limits the whole path to 260 chars by
# default, so the same conservative budget keeps names portable both ways.
DEFAULT_NAME_MAX = 255
MAX_RELATIVE_SEGMENTS = 32

RESERVED_WINDOWS_NAMES = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$", re.IGNORECASE)
INVALID_FILENAME_CHARS = re.compile(r'[\x00-\x1f<>:"|?*\\]')


# ---------------------------------------------------------------------------
# Helpers - platform / path
# ---------------------------------------------------------------------------

def _input_root() -> str:
    if folder_paths is None:
        raise RuntimeError("folder_paths 不可用，请确认插件运行在 ComfyUI 内。")
    root = os.path.abspath(os.path.expanduser(folder_paths.get_input_directory()))
    try:
        os.makedirs(root, exist_ok=True)
    except OSError as exc:
        raise RuntimeError(f"无法访问 ComfyUI 输入目录 {root}：{exc}") from exc
    return root


def _ensure_dir(path: str) -> str:
    """Create our own directories with portable, world-readable permissions."""
    os.makedirs(path, exist_ok=True)
    if not IS_WINDOWS:
        # A restrictive umask (common in Docker/systemd) can otherwise produce
        # 0700 directories that other ComfyUI users/processes cannot read.
        try:
            os.chmod(path, 0o755)
        except OSError:
            pass
    return path


def _name_max(directory: str) -> int:
    """Return the filesystem's per-component filename limit in bytes."""
    pathconf = getattr(os, "pathconf", None)
    if pathconf is not None:
        try:
            value = int(pathconf(directory, "PC_NAME_MAX"))
            if value > 0:
                return value
        except (OSError, ValueError):
            pass
    return DEFAULT_NAME_MAX


def _truncate_utf8(text: str, limit: int) -> str:
    """Truncate to at most `limit` UTF-8 bytes without breaking characters."""
    if limit <= 0:
        return ""
    data = text.encode("utf-8", "ignore")
    if len(data) <= limit:
        return text
    return data[:limit].decode("utf-8", "ignore")


def _truncate_filename(name: str, limit: int) -> str:
    """Byte-aware truncation that preserves the file extension.

    Counting characters is not enough on Linux: a 140-character CJK name is
    ~420 bytes and raises ENAMETOOLONG, while the same name is fine on Windows.
    """
    if limit <= 0:
        return name
    if len(name.encode("utf-8", "ignore")) <= limit:
        return name
    stem, ext = os.path.splitext(name)
    ext = _truncate_utf8(ext, max(8, limit // 5))
    budget = max(1, limit - len(ext.encode("utf-8", "ignore")))
    stem = _truncate_utf8(stem, budget).rstrip(" .")
    if not stem:
        stem = "image"
    return stem + ext


def _is_within(root: str, path: str) -> bool:
    """True when `path` resolves inside `root` (symlink aware, drive safe)."""
    try:
        root_real = os.path.realpath(root)
        path_real = os.path.realpath(path)
        return os.path.commonpath([root_real, path_real]) == root_real
    except (ValueError, OSError):
        # ValueError: different drives on Windows / mixed absolute+relative.
        return False


def _safe_segment(segment: str, fallback: str = "image", limit: int = DEFAULT_NAME_MAX) -> str:
    name = str(segment or "").replace("/", "_").replace("\\", "_")
    name = INVALID_FILENAME_CHARS.sub("_", name).strip(" .")
    if not name or name in (".", ".."):
        name = fallback
    if RESERVED_WINDOWS_NAMES.match(name):
        name = "_" + name
    return _truncate_filename(name, limit) or fallback


def _safe_relative_path(raw_path: str, fallback_name: str) -> str:
    """Return a sanitized, relative, forward-slash path."""
    clean = str(raw_path or "").replace("\\", "/").lstrip("/")
    parts = []
    for part in PurePosixPath(clean).parts:
        if part in ("", ".", ".."):
            continue
        parts.append(part)
    if not parts:
        parts = [_safe_segment(fallback_name, "image")]
    # Guard against pathological nesting from deeply recursive folders.
    parts = parts[-MAX_RELATIVE_SEGMENTS:]
    return "/".join(_safe_segment(part) for part in parts)


def _unique_path(directory: str, relative_path: str) -> str:
    """Find a non-existing path under directory and create its parent dirs."""
    directory = os.path.abspath(directory)
    rel_parts = [part for part in relative_path.split("/") if part]
    candidate = os.path.abspath(os.path.join(directory, *rel_parts))
    if not _is_within(directory, candidate):
        raise ValueError("非法上传路径")

    parent = os.path.dirname(candidate)
    _ensure_dir(parent)
    stem, ext = os.path.splitext(candidate)
    counter = 2
    while os.path.lexists(candidate):
        candidate = f"{stem} ({counter}){ext}"
        counter += 1
    return candidate


def _cleanup_old_sessions(upload_root: str) -> None:
    try:
        now = time.time()
        for name in os.listdir(upload_root):
            path = os.path.join(upload_root, name)
            if not os.path.isdir(path) or os.path.islink(path):
                continue
            try:
                if now - os.path.getmtime(path) > SESSION_MAX_AGE_SECONDS:
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                continue
    except OSError:
        return


def _resolve_uploaded_path(relative_path: str) -> str:
    """Resolve a stored upload path safely inside ComfyUI's input directory."""
    root = _input_root()
    normalized = str(relative_path or "").replace("\\", "/").strip("/")
    if not normalized.startswith(UPLOAD_ROOT_NAME + "/"):
        raise ValueError("节点中的图片路径不属于素材浏览器上传目录。")

    parts = [p for p in normalized.split("/") if p not in ("", ".", "..")]
    if len(parts) < 3:
        raise ValueError("节点中的图片路径无效。")

    full_path = os.path.abspath(os.path.join(root, *parts))
    if not _is_within(root, full_path):
        raise ValueError("节点中的图片路径越界。")
    if not os.path.isfile(full_path):
        raise ValueError(f"图片文件不存在：{normalized}")
    return full_path


def _load_rgb_image(path: str) -> tuple[Image.Image, np.ndarray]:
    with Image.open(path) as image:
        image.load()
        try:
            upright = ImageOps.exif_transpose(image)
        except Exception:
            upright = None
        rgb = (upright if upright is not None else image).convert("RGB")
    array = np.asarray(rgb, dtype=np.float32) / 255.0
    return rgb, array


def _entry_path(entry) -> str | None:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        return entry.get("path") or entry.get("filename")
    return None


def _node_sort_key(node_id: str):
    text = str(node_id)
    match = re.match(r"(\d+)", text)
    if match:
        return (0, int(match.group(1)), text)
    return (1, 0, text)


def _prompt_link(value):
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return tuple(str(part) for part in value)
    return None


def _load_preview_original(source: dict, position: int):
    """Load the original file for a preview slot, preserving its native size."""
    try:
        raw_data = (source.get("inputs") or {}).get("images_data")
        if isinstance(raw_data, str):
            entries = json.loads(raw_data or "[]")
        elif isinstance(raw_data, list):
            entries = raw_data
        else:
            return None
        if not isinstance(entries, list) or not entries:
            return None

        relative_path = _entry_path(entries[position % len(entries)])
        if not relative_path:
            return None

        full_path = _resolve_uploaded_path(relative_path)
        _, array = _load_rgb_image(full_path)
        return torch.from_numpy(array).unsqueeze(0)
    except Exception as exc:
        print("[huan AssetBrowser] native preview fallback:", exc)
        return None


def _slice_preview_batch(images, prompt: dict | None, unique_id: str | None):
    """Return one frame for each standard PreviewImage on a huan output.

    A single output link cannot carry different data to each downstream node.
    However, when several standard PreviewImage nodes are attached to the same
    huan output, each preview may save a distinct frame based on its node-id
    order.  With zero or one preview connected, normal ComfyUI behavior (show
    the entire batch) is kept.

    For multiple previews we load the original uploaded file instead of slicing
    the padded batch.  This keeps each preview's native size/aspect ratio, even
    though the IMAGE batch itself must use one common padded resolution.
    """
    try:
        if not prompt or unique_id is None or not hasattr(images, "shape"):
            return images
        current = str(unique_id)
        own_data = prompt.get(current)
        if not isinstance(own_data, dict):
            return images
        target = _prompt_link((own_data.get("inputs") or {}).get("images"))
        if target is None:
            return images

        source = prompt.get(target[0])
        if not isinstance(source, dict) or source.get("class_type") != "huan_AssetBrowser":
            return images

        siblings: list[str] = []
        for node_id, node_data in prompt.items():
            if not isinstance(node_data, dict):
                continue
            if node_data.get("class_type") != "PreviewImage":
                continue
            link = _prompt_link((node_data.get("inputs") or {}).get("images"))
            if link == target:
                siblings.append(str(node_id))

        if len(siblings) <= 1:
            return images
        siblings.sort(key=_node_sort_key)
        if current not in siblings:
            return images

        batch_size = int(images.shape[0])
        if batch_size <= 1:
            return images
        position = siblings.index(current)
        native = _load_preview_original(source, position)
        if native is not None:
            return native
        index = position % batch_size
        return images[index:index + 1]
    except Exception as exc:
        print("[huan AssetBrowser] preview slice fallback:", exc)
        return images


# ---------------------------------------------------------------------------
# PreviewImage patch
# ---------------------------------------------------------------------------

_PREVIEW_MODULE_HINTS = (
    "nodes",
    "comfy_extras.nodes_images",
    "comfy_extras.nodes_preview_image",
)


def _find_preview_class():
    """Locate ComfyUI's core PreviewImage class across versions."""
    for module_name in _PREVIEW_MODULE_HINTS:
        module = sys.modules.get(module_name)
        candidate = getattr(module, "PreviewImage", None) if module is not None else None
        if isinstance(candidate, type) and callable(getattr(candidate, "INPUT_TYPES", None)):
            return candidate

    # Fallback: some builds move the node into another comfy_extras module.
    for module_name, module in list(sys.modules.items()):
        if not module_name or module is None:
            continue
        candidate = getattr(module, "PreviewImage", None)
        if isinstance(candidate, type) and callable(getattr(candidate, "INPUT_TYPES", None)):
            return candidate
    return None


def _accepted_kwargs(func):
    """Parameter names accepted by `func`, or None when it takes **kwargs."""
    try:
        parameters = inspect.signature(func).parameters
    except (TypeError, ValueError):
        return None
    if any(param.kind is inspect.Parameter.VAR_KEYWORD for param in parameters.values()):
        return None
    return set(parameters)


def _install_previewimage_patch() -> None:
    """Extend core PreviewImage only for inputs coming from this plugin."""
    try:
        preview_class = _find_preview_class()
    except Exception as exc:  # pragma: no cover
        print("[huan AssetBrowser] cannot locate PreviewImage:", exc)
        return

    if preview_class is None:
        print(
            "[huan AssetBrowser] PreviewImage 未找到，"
            "多个预览节点自动分图功能不可用（其余功能正常）。"
        )
        return
    if getattr(preview_class, "_huan_asset_patch", False):
        return

    original_input_types = getattr(preview_class, "INPUT_TYPES", None)
    original_save_images = getattr(preview_class, "save_images", None)
    if not callable(original_input_types) or not callable(original_save_images):
        print(
            "[huan AssetBrowser] PreviewImage 使用了新的节点定义方式，"
            "跳过预览分图补丁（其余功能正常）。"
        )
        return

    accepted = _accepted_kwargs(original_save_images)

    @classmethod
    def patched_input_types(cls):
        func = getattr(original_input_types, "__func__", original_input_types)
        data = func(cls)
        if isinstance(data, dict):
            hidden = data.setdefault("hidden", {})
            if isinstance(hidden, dict):
                hidden.setdefault("unique_id", "UNIQUE_ID")
        return data

    def patched_save_images(self, images, filename_prefix="ComfyUI", prompt=None,
                            extra_pnginfo=None, unique_id=None, **kwargs):
        selected = _slice_preview_batch(images, prompt, unique_id)
        call_kwargs = dict(kwargs)
        call_kwargs.update({
            "filename_prefix": filename_prefix,
            "prompt": prompt,
            "extra_pnginfo": extra_pnginfo,
        })
        if accepted is not None:
            call_kwargs = {key: value for key, value in call_kwargs.items() if key in accepted}
        output = original_save_images(self, selected, **call_kwargs)
        # Keep PreviewImage's (rarely used) output semantically equivalent to
        # ComfyUI's stock node: the UI gets one sliced frame, but downstream
        # nodes still receive the original batch.
        if isinstance(output, dict) and "result" in output:
            output["result"] = (images,)
        return output

    preview_class.INPUT_TYPES = patched_input_types
    preview_class.save_images = patched_save_images
    preview_class._huan_asset_patch = True
    print("[huan AssetBrowser] patched core PreviewImage for automatic per-preview slicing")


# ---------------------------------------------------------------------------
# Upload endpoint
# ---------------------------------------------------------------------------

UPLOAD_ROUTE = "/huan_asset_browser/upload"


def _route_registered(routes, path: str, method: str = "POST") -> bool:
    """Detect an already registered route.

    Duplicate copies of this plugin inside ``custom_nodes`` would otherwise
    register the same path twice and make aiohttp/ComfyUI raise at startup.
    """
    try:
        for route in list(routes):
            if getattr(route, "path", None) != path:
                continue
            methods = str(getattr(route, "method", "") or "").upper()
            if not methods or methods == "*" or method.upper() in methods:
                return True
    except Exception:
        return False
    return False


def _register_routes() -> None:
    if PromptServer is None or web is None:
        return
    if getattr(_register_routes, "_done", False):
        return
    try:
        routes = PromptServer.instance.routes
    except Exception:
        return

    if _route_registered(routes, UPLOAD_ROUTE):
        print(
            "[huan AssetBrowser] 上传路由已存在，跳过重复注册。"
            "请检查 custom_nodes 下是否有重复的插件副本。"
        )
        _register_routes._done = True
        return

    async def upload_assets(request):
        session_dir = None
        try:
            post = await request.post()
            raw_fields = post.getall("files") or post.getall("file") or []
            if not raw_fields:
                return web.json_response({"ok": False, "error": "没有收到图片文件。"}, status=400)
            if len(raw_fields) > MAX_UPLOAD_FILES:
                return web.json_response(
                    {"ok": False, "error": f"一次最多同步 {MAX_UPLOAD_FILES} 张图片。"},
                    status=400,
                )

            try:
                paths = json.loads(post.get("paths") or "[]")
                if not isinstance(paths, list):
                    paths = []
            except Exception:
                paths = []

            input_root = _input_root()
            upload_root = _ensure_dir(os.path.join(input_root, UPLOAD_ROOT_NAME))
            _cleanup_old_sessions(upload_root)

            session = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:8]
            session_dir = _ensure_dir(os.path.join(upload_root, session))
            name_limit = _name_max(session_dir)

            uploaded = []
            for index, field in enumerate(raw_fields):
                filename = getattr(field, "filename", None) or f"image_{index + 1}.jpg"
                raw_path = paths[index] if index < len(paths) else filename
                relative_path = _safe_relative_path(raw_path, filename)
                if name_limit != DEFAULT_NAME_MAX:
                    relative_path = "/".join(
                        _safe_segment(part, "image", name_limit) for part in relative_path.split("/")
                    )
                destination = _unique_path(session_dir, relative_path)

                data = getattr(field, "file", None)
                if data is None:
                    raise ValueError(f"无法读取图片「{filename}」的上传数据。")
                data.seek(0)
                with open(destination, "wb") as handle:
                    shutil.copyfileobj(data, handle)
                if not IS_WINDOWS:
                    try:
                        os.chmod(destination, 0o644)
                    except OSError:
                        pass

                try:
                    if os.path.getsize(destination) <= 0:
                        raise ValueError("文件为空")
                    with Image.open(destination) as image:
                        image.load()
                        width, height = image.size
                        image_format = (image.format or "").upper()
                        if width <= 0 or height <= 0:
                            raise ValueError("无效的图片尺寸")
                except Exception as exc:
                    try:
                        os.remove(destination)
                    except OSError:
                        pass
                    raise ValueError(f"无法读取图片「{filename}」：{exc}") from exc

                rel_from_session = os.path.relpath(destination, session_dir).replace(os.sep, "/")
                uploaded.append({
                    "path": f"{UPLOAD_ROOT_NAME}/{session}/{rel_from_session}",
                    "name": os.path.basename(filename),
                    "source": relative_path,
                    "width": int(width),
                    "height": int(height),
                    "format": image_format,
                    "size": os.path.getsize(destination),
                })

            return web.json_response({
                "ok": True,
                "session": session,
                "count": len(uploaded),
                "files": uploaded,
            })
        except Exception as exc:
            print("[huan AssetBrowser] upload error:", exc)
            if session_dir:
                shutil.rmtree(session_dir, ignore_errors=True)
            # aiohttp rejects bodies above ComfyUI's --max-upload-size with 413;
            # keep that status so the browser can show a helpful hint.
            status = 413 if getattr(exc, "status", None) == 413 else 400
            return web.json_response({"ok": False, "error": str(exc)}, status=status)

    try:
        routes.post(UPLOAD_ROUTE)(upload_assets)
    except Exception as exc:
        print("[huan AssetBrowser] 上传路由注册失败:", exc)
        return
    _register_routes._done = True
    try:
        print(f"[huan AssetBrowser] route registered: POST {UPLOAD_ROUTE}")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------

class huan_AssetBrowser:
    """Browse a local image folder and output the chosen images as one batch."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images_data": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "tooltip": "由节点内嵌素材浏览器自动写入；请不要手动修改。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "load_images"
    CATEGORY = "huan 素材"
    DESCRIPTION = (
        "在节点内嵌的素材浏览器中选择图片后会自动同步，"
        "选中的图片会作为单个 IMAGE batch 从唯一输出口输出。"
        "多个标准预览图像节点连接同一个输出时会自动分别显示不同图片。"
        "打开节点状态栏的「逐张」开关后，点运行会按顺序每张图各跑一次完整工作流；"
        "再打开「续跑」，队列跑空后会继续等新放进文件夹的图片接着跑。"
    )
    OUTPUT_TOOLTIPS = ("选中的图片批次；连接多个标准预览图像节点时会自动分图。",)

    def load_images(self, images_data="[]"):
        try:
            entries = json.loads(images_data or "[]")
        except Exception as exc:
            raise ValueError("节点中的图片选择数据损坏，请重新在素材浏览器中选择图片。") from exc
        if not isinstance(entries, list):
            raise ValueError("节点中的图片选择数据格式无效。")
        if not entries:
            raise ValueError("请先在节点内选择图片。")

        arrays = []
        max_width = 0
        max_height = 0
        for entry in entries:
            relative_path = _entry_path(entry)
            if not relative_path:
                continue

            path = _resolve_uploaded_path(relative_path)
            _, array = _load_rgb_image(path)
            height, width = array.shape[:2]
            arrays.append(array)
            max_width = max(max_width, width)
            max_height = max(max_height, height)

        if not arrays:
            raise ValueError("没有可读取的图片，请重新在素材浏览器中选择。")

        # Different source resolutions are letterboxed onto a common canvas so
        # ComfyUI receives a valid batch without stretching the images.
        batch = np.zeros((len(arrays), max_height, max_width, 3), dtype=np.float32)
        for index, array in enumerate(arrays):
            height, width = array.shape[:2]
            x = (max_width - width) // 2
            y = (max_height - height) // 2
            batch[index, y:y + height, x:x + width, :] = array

        return (torch.from_numpy(batch),)


# Register routes during custom-node import, before aiohttp freezes its router.
_register_routes()
_install_previewimage_patch()


NODE_CLASS_MAPPINGS = {
    "huan_AssetBrowser": huan_AssetBrowser,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "huan_AssetBrowser": "huan_素材浏览器",
}

__all__ = [
    "huan_AssetBrowser",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
