import {
  DOCUMENT_FOLDERS,
  folderFromKind,
  type DocumentFolder,
} from "./auth";

export { DOCUMENT_FOLDERS, folderFromKind };
export type { DocumentFolder };

export interface AttachmentMeta {
  id?: string;
  deal_id?: string;
  filename?: string;
  content_type?: string;
  kind?: string;
  folder?: string;
  path?: string;
  key?: string;
  storage?: string;
  bytes?: number;
  ocr_status?: string;
  ocr_text?: string | null;
  created_at?: string;
}

export function normalizeFolder(value?: string | null): DocumentFolder {
  const v = (value || "").toLowerCase();
  if ((DOCUMENT_FOLDERS as readonly string[]).includes(v)) {
    return v as DocumentFolder;
  }
  return folderFromKind(value);
}

export function withFolder(att: AttachmentMeta, dealId?: string): AttachmentMeta {
  const folder = normalizeFolder(
    att.folder || folderFromKind(att.kind, att.filename)
  );
  return {
    ...att,
    deal_id: att.deal_id || dealId,
    folder,
  };
}

export function listDealAttachments(
  metadata: unknown,
  dealId: string
): AttachmentMeta[] {
  const meta =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : {};
  const raw = Array.isArray(meta.attachments) ? meta.attachments : [];
  return raw
    .filter((x): x is AttachmentMeta => Boolean(x) && typeof x === "object")
    .map((att) => withFolder(att, dealId));
}
