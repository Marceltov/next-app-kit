// next-app-kit/files: the files that come with an app's records, moved from noticebox (ADR 0007 there). Three parts that go together:
// readUpload takes a form's post with a rule for each file field and lists every problem; FileStore keeps the files in the app's own
// SQLite database, in chunks, written in the same transaction as the record they belong to; fileResponse serves one safely (a download
// unless it is a common photo format, never sniffed, sandboxed), and signedFileUrl hands it out for a few minutes without signing in.
export { readUpload, accepted, type FieldRule, type ReceivedFile, type Upload, type UploadOptions, type UploadProblem } from "./upload.js";
export { FileStore, filesMigration, CHUNK_BYTES, type FilesConnection, type NewFile, type StoredFile } from "./store.js";
export { fileResponse, isPicture, PICTURE_TYPES, signedFileUrl, signedFor, type LinkSigner } from "./serve.js";
