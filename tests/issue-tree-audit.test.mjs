import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, commentBody, MARKER, problems, ratchet } from "../scripts/issue-tree-audit.mjs";

const issue = (o) => ({ key: "r#1", repo: "r", number: 1, state: "OPEN", type: "Task", parent: 7, ...o });

test("no type is a problem; a Bug or a Task without a parent is a problem; a Feature needs no parent", () => {
  assert.deepEqual(problems({ type: null }), ["type"]);
  assert.deepEqual(problems({ type: "Bug", parent: null }), ["parent"]);
  assert.deepEqual(problems({ type: "Task", parent: null }), ["parent"]);
  assert.deepEqual(problems({ type: "Feature", parent: null }), []);
  assert.deepEqual(problems({ type: "Task", parent: 3 }), []);
});

test("audit keeps only the open issues that break the rule", () => {
  const out = audit([issue({}), issue({ key: "r#2", type: null }), issue({ key: "r#3", parent: null }), issue({ key: "r#4", type: null, state: "CLOSED" })]);
  assert.deepEqual(out.map((i) => i.key), ["r#2", "r#3"]);
});

test("the ratchet fails when the count grows and says when it can be lowered", () => {
  assert.deepEqual(ratchet(5, 5), { ok: true, lower: null });
  assert.deepEqual(ratchet(3, 5), { ok: true, lower: 3 });
  assert.equal(ratchet(6, 5).ok, false);
});

test("the comment carries the marker (posted once), says what is missing and links the rules", () => {
  assert.ok(commentBody(["type"]).startsWith(MARKER));
  assert.match(commentBody(["type"]), /issue type/);
  assert.match(commentBody(["parent"]), /parent Feature/);
  assert.match(commentBody(["type", "parent"]), /issue type.* and .*parent Feature/);
  assert.match(commentBody(["parent"]), /rules\.md#issue-tree/);
});
