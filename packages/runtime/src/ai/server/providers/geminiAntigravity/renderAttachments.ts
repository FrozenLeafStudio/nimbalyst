/**
 * Render chat attachments into flat text for the text-loop transport, which
 * has no multimodal channel -- `GetModelResponse` takes a single prompt
 * string, so an attachment reaches the model only if it is folded into that
 * string. `type: 'document'` attachments (which is what a pasted-text
 * attachment is: `AttachmentService` maps `mimeType: 'text/plain'` to
 * `type: 'document'`, same as a genuinely-dropped .txt/.md file) are read and
 * inlined, capped like a tool result so a large paste cannot grow the
 * single-shot prompt unbounded. `image`/`pdf` attachments have no
 * text-extraction path anywhere in this codebase (every other provider
 * either bundles them as a multimodal API content block, which this
 * transport has no equivalent of, or -- OpenAICodexProvider -- names them
 * without reading them) -- so they're named, not inlined, matching that same
 * "can't deliver this, so at least say so" precedent.
 *
 * Kept as a standalone module (not a method on `AntigravityToolLoopProtocol`)
 * because the Cascade transport (Phase 2A) will need the same rendering.
 */

import * as fs from 'fs';
import type { ChatAttachment } from '../../types';
import { neutralizeUntrustedText } from './AntigravityToolLoopProtocol';

// Same order of magnitude as AntigravityToolLoopProtocol's TOOL_RESULT_MAX_CHARS,
// for the same reason: the whole history is re-rendered into one prompt every
// turn, so an uncapped attachment would grow it unboundedly.
const ATTACHMENT_MAX_CHARS = 24_000;

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Strip any literal occurrence of this module's own wrapper tags from untrusted content. */
function stripOwnWrapperTags(text: string): string {
  return text
    .replace(/<\/?ATTACHED_DOCUMENT\b[^>]*>/g, '')
    .replace(/<\/?UNAVAILABLE_ATTACHMENTS>/g, '');
}

async function renderDocumentAttachment(attachment: ChatAttachment): Promise<string> {
  const filename = escapeAttrValue(attachment.filename);
  let raw: string;
  try {
    raw = await fs.promises.readFile(attachment.filepath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<ATTACHED_DOCUMENT filename="${filename}">\n[could not be read: ${message}]\n</ATTACHED_DOCUMENT>`;
  }
  const capped = raw.length > ATTACHMENT_MAX_CHARS
    ? `${raw.slice(0, ATTACHMENT_MAX_CHARS)}\n\n[ATTACHMENT TRUNCATED at ${ATTACHMENT_MAX_CHARS} characters; ` +
      `${raw.length} total. Ask the user to share the relevant section if you need more.]`
    : raw;
  const safe = stripOwnWrapperTags(neutralizeUntrustedText(capped));
  return `<ATTACHED_DOCUMENT filename="${filename}">\n${safe}\n</ATTACHED_DOCUMENT>`;
}

/**
 * Render the current turn's attachments into the block folded into the
 * model-visible history entry. Returns `''` when there is nothing to render
 * (no attachments) so callers can skip appending on the common case.
 */
export async function renderAttachments(attachments: ChatAttachment[] | undefined): Promise<string> {
  if (!attachments || attachments.length === 0) return '';

  const documentBlocks: string[] = [];
  const unavailable: string[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'document') {
      documentBlocks.push(await renderDocumentAttachment(attachment));
    } else {
      unavailable.push(`- ${attachment.filename} (${attachment.type})`);
    }
  }

  const parts = [...documentBlocks];
  if (unavailable.length > 0) {
    parts.push(
      '<UNAVAILABLE_ATTACHMENTS>\n'
        + 'This provider cannot read the following attachments; do not guess at their contents:\n'
        + `${unavailable.join('\n')}\n`
        + '</UNAVAILABLE_ATTACHMENTS>',
    );
  }
  return parts.join('\n\n');
}
