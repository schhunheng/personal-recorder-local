"""Validated, path-free request schemas for the local automated editor."""
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

class Schema(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)

class Interval(Schema):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    @model_validator(mode='after')
    def ordered(self):
        if self.end <= self.start: raise ValueError('End must be after start')
        return self

class Cut(Interval):
    id: str = Field(max_length=100)
    reason: Literal['silence', 'retake', 'manual'] = 'manual'
    accepted: bool = True

class Marker(Schema):
    id: str = Field(max_length=100)
    time: float = Field(ge=0)
    kind: Literal['important', 'zoom', 'retake_start', 'retake_end', 'chapter']
    label: str = Field(default='', max_length=160)
    x: float = Field(default=.5, ge=0, le=1)
    y: float = Field(default=.5, ge=0, le=1)

class Zoom(Schema):
    id: str = Field(max_length=100)
    time: float = Field(ge=0)
    duration: float = Field(default=.7, ge=.05, le=10)
    scale: float = Field(default=2, ge=1, le=3)
    x: float = Field(default=.5, ge=0, le=1)
    y: float = Field(default=.5, ge=0, le=1)

class Camera(Schema):
    visible: bool = True
    shape: Literal['circle', 'rounded'] = 'circle'
    size: float = Field(default=.22, ge=.05, le=.6)
    x: float = Field(default=.84, ge=0, le=1)
    y: float = Field(default=.78, ge=0, le=1)
    mirror: bool = True
    opacity: float = Field(default=1, ge=0, le=1)
    border: bool = True
    shadow: bool = True

class ScreenMask(Interval):
    id: str = Field(min_length=1, max_length=100)
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(ge=.01, le=1)
    height: float = Field(ge=.01, le=1)
    color: str = '#000000'
    @field_validator('color')
    @classmethod
    def hex_color(cls, value):
        import re
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', value): raise ValueError('Use a hex color')
        return value
    @model_validator(mode='after')
    def inside_screen(self):
        if self.x + self.width > 1 + 1e-9 or self.y + self.height > 1 + 1e-9:
            raise ValueError('Hidden area exceeds screen bounds')
        return self

class Appearance(Schema):
    background: str = '#182b29'
    padding: float = Field(default=.045, ge=0, le=.2)
    paddingX: float | None = Field(default=None, ge=0, le=.2)
    paddingY: float | None = Field(default=None, ge=0, le=.2)
    radius: float = Field(default=16, ge=0, le=100)
    shadow: bool = True
    ratio: Literal['16:9', '1:1', '9:16'] = '16:9'
    watermark: bool = False
    watermarkColor: str = 'auto'
    title: str = Field(default='', max_length=120)
    intro: bool = False
    outro: bool = False
    @field_validator('background', 'watermarkColor')
    @classmethod
    def color(cls, value, info):
        import re
        if info.field_name == 'watermarkColor' and value == 'auto': return value
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', value): raise ValueError('Use a hex color')
        return value

class Caption(Interval):
    id: str = Field(max_length=100)
    text: str = Field(max_length=1200)

class CaptionStyle(Schema):
    font: Literal['Arial', 'Noto Sans Khmer', 'Khmer OS', 'Kohinoor Khmer', 'Khmer MN', 'Khmer Sangam MN'] = 'Khmer Sangam MN'
    size: int = Field(default=42, ge=16, le=100)
    position: Literal['bottom', 'top', 'center'] = 'bottom'
    animation: Literal['none', 'fade'] = 'none'
    burn: bool = False

class Chapter(Schema):
    time: float = Field(ge=0)
    title: str = Field(max_length=160)

class EDL(Schema):
    schema_version: int = 1
    source_duration: float = Field(gt=0)
    trim: Interval
    cuts: list[Cut] = Field(default_factory=list, max_length=2000)
    zooms: list[Zoom] = Field(default_factory=list, max_length=500)
    masks: list[ScreenMask] = Field(default_factory=list, max_length=100)
    camera: Camera = Field(default_factory=Camera)
    appearance: Appearance = Field(default_factory=Appearance)
    captions: list[Caption] = Field(default_factory=list, max_length=20000)
    caption_style: CaptionStyle = Field(default_factory=CaptionStyle)
    chapters: list[Chapter] = Field(default_factory=list, max_length=200)
    @model_validator(mode='after')
    def bounded(self):
        if self.trim.end > self.source_duration + .1: raise ValueError('Trim exceeds source duration')
        for region in self.cuts + self.captions + self.masks:
            if region.end > self.source_duration + .1: raise ValueError('Timeline region exceeds source duration')
        return self

class PipelineOptions(Schema):
    preset: Literal['clean', 'professional', 'social'] = 'clean'
    clip_seconds: float = Field(default=60, ge=10, le=180)
    noise: Literal['off', 'light', 'balanced', 'strong', 'ai'] = 'balanced'
    noise_engine: Literal['auto', 'rnnoise', 'deepfilter', 'spectral'] = 'auto'
    noise_strength: float | None = Field(default=None, ge=0, le=1)
    audio_source: Literal['auto', 'microphone', 'screen'] = 'auto'
    normalize: bool = True
    vad: Literal['auto', 'silero', 'energy'] = 'auto'
    minimum_silence: float = Field(default=1.8, ge=.5, le=30)
    speech_padding: float = Field(default=.4, ge=.1, le=1)
    threshold_db: float = Field(default=-38, ge=-65, le=-15)
    accept_silence: bool = True
    transcribe: bool = False
    language: Literal['km', 'en', 'auto'] = 'km'
    profile: Literal['lms', 'vertical'] = 'lms'
    quality: Literal['high', 'standard'] = 'high'
    bitrate_mbps: float = Field(default=12, ge=2, le=40)
    height: Literal[360, 720, 1080, 1440] = 1080
    fps: Literal[30, 60] = 30
    # plan creates an automatic draft; render respects the user's saved EDL exactly.
    action: Literal['plan', 'render'] = 'plan'
    edl: EDL | None = None

class NewProject(Schema):
    id: UUID
    title: str = Field(min_length=1, max_length=200)
    duration: float = Field(gt=0, le=14400)
    markers: list[Marker] = Field(default_factory=list, max_length=2000)
    timing: dict = Field(default_factory=dict)

class TimelineUpdate(Schema):
    base_version: int = Field(ge=0)
    edl: EDL
