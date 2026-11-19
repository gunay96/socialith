// @socialith/video-engine — FFmpeg rendering pipeline + local asset
// storage. Implemented for real in Phase 07: `extractThumbnail` shells
// out to a real FFmpeg binary, `saveLocalFile` writes real bytes to disk.
// Crop/subtitles/intro-outro are documented as future VideoRenderOperation
// values (schema.prisma), not implemented here yet.
export * from "./ffmpeg.js";
export * from "./storage.js";
export * from "./presets.js";
export * from "./operations.js";
