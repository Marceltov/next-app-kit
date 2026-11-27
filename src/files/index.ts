// next-app-kit/files: the files that come with an app's records, moved from noticebox (ADR 0007 there). FileStore keeps them in the
// app's own SQLite database, in chunks, written in the same transaction as the record they belong to (they arrive through
// next-app-kit/multipart); fileResponse serves one safely (a download unless it is a common photo format, never sniffed, sandboxed), and
// signedFileUrl hands it out for a few minutes without signing in.
export { FileStore, FILES_SCHEMA, CHUNK_BYTES, type FilesConnection, type NewFile, type StoredFile } from "./store.js";
export { fileResponse, isPicture, PICTURE_TYPES, signedFileUrl, signedFor, type LinkSigner } from "./serve.js";
