"""huan Asset Browser - ComfyUI custom node.

Cross-platform: Windows / Linux / macOS, Python 3.10 - 3.13, ComfyUI 0.3.x.
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS, __version__

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]
