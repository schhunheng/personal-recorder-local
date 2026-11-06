import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Config:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv('EDU_DATA_DIR', 'backend/data')).resolve())
    max_bytes: int = field(default_factory=lambda: int(os.getenv('EDU_MAX_UPLOAD_MB', '2048')) * 1024 * 1024)
    max_duration: float = field(default_factory=lambda: float(os.getenv('EDU_MAX_DURATION_SECONDS', '7200')))
    retention_days: float = field(default_factory=lambda: float(os.getenv('EDU_RETENTION_DAYS', '7')))
    ffmpeg: str = field(default_factory=lambda: os.getenv('EDU_FFMPEG', 'ffmpeg'))
    ffprobe: str = field(default_factory=lambda: os.getenv('EDU_FFPROBE', 'ffprobe'))
    model_dir: str = field(default_factory=lambda: os.getenv('EDU_DF_MODEL_DIR', ''))
