import assert from "node:assert/strict";
import { test } from "node:test";

import { SPLIT, splitReply } from "./reply.ts";

test("a reply without a separator is one message, trimmed", () => {
  assert.deepEqual(splitReply("  你好\n\n再见  \n"), ["你好\n\n再见"]);
});

test("a separator line splits a reply in two, and two in three", () => {
  assert.deepEqual(splitReply(`一\n${SPLIT}\n二`), ["一", "二"]);
  assert.deepEqual(splitReply(`一\n${SPLIT}\n二\n${SPLIT}\n三`), ["一", "二", "三"]);
});

test("a separator line may have whitespace around it", () => {
  assert.deepEqual(splitReply(`一\n  ${SPLIT}  \n二\n\t${SPLIT}\n三`), ["一", "二", "三"]);
});

test("a separator inside a fenced code block does not split", () => {
  const code = `\`\`\`html\n${SPLIT}\n<p>x</p>\n\`\`\``;
  assert.deepEqual(splitReply(`先看：\n${code}\n${SPLIT}\n再说`), [`先看：\n${code}`, "再说"]);
  const tilde = `~~~\n${SPLIT}\n~~~`;
  assert.deepEqual(splitReply(tilde), [tilde]);
});

test("a separator after a closed fence splits again", () => {
  assert.deepEqual(splitReply(`\`\`\`\nx\n\`\`\`\n${SPLIT}\n二`), ["```\nx\n```", "二"]);
});

test("a separator that is not alone on its line does not split", () => {
  assert.deepEqual(splitReply(`一 ${SPLIT} 二`), [`一 ${SPLIT} 二`]);
});

test("empty parts are dropped", () => {
  assert.deepEqual(splitReply(`${SPLIT}\n一\n${SPLIT}\n\n${SPLIT}\n二\n${SPLIT}`), ["一", "二"]);
});

test("empty text has no messages", () => {
  assert.deepEqual(splitReply(""), []);
  assert.deepEqual(splitReply(" \n "), []);
  assert.deepEqual(splitReply(SPLIT), []);
});
