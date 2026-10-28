#!/usr/bin/env node
// Issue tree audit (Oussama, 2026-10-28: every issue has an org issue type, every Bug and Task is a sub-issue of a Feature).
//
//   node scripts/issue-tree-audit.mjs [--dry] [--org krizaka] [--project 4] [--baseline issue-tree-baseline.json]
//
// Lists the open issues of the org project: no issue type, or a Bug / Task with no parent. Each one gets ONE comment
// (marker below, never repeated) and the label `needs-triage` (removed when the issue is fixed). The run FAILS when the
// count grows against the baseline file (a ratchet: the count only goes down; lower it with the number printed).
// Token: GH_TOKEN of the Krizaka Agents app (Issues: write, Organization projects: read), minted by the workflow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- issue-tree-audit -->";
export const LABEL = "needs-triage";
export const NEEDS_PARENT = new Set(["Bug", "Task"]);
export const RULES_URL = "https://github.com/krizaka/.github/blob/main/docs/standards/rules.md#issue-tree";

/** Pure rule: what is wrong with an issue (`[]` when it is fine). */
export function problems({ type = null, parent = null }) {
  if (!type) return ["type"];
  if (NEEDS_PARENT.has(type) && !parent) return ["parent"];
  return [];
}

/** The open issues that break the rule: the issue plus its `problems`. */
export function audit(items) {
  return items
    .filter((i) => i.state === "OPEN")
    .map((i) => ({ ...i, problems: problems(i) }))
    .filter((i) => i.problems.length);
}

/** The ratchet: ok while the count does not grow; `lower` is set when it can be tightened. */
export function ratchet(count, baseline) {
  return { ok: count <= baseline, lower: count < baseline ? count : null };
}

export function commentBody(ps) {
  const need = [];
  if (ps.includes("type")) need.push("an **issue type** (Feature, Bug or Task)");
  if (ps.includes("parent")) need.push("a **parent Feature** (a Bug or a Task is a sub-issue of a Feature)");
  return `${MARKER}\nThis issue needs ${need.join(" and ")}, so the board's sub-issue progress tells the truth. Rules: [the issue tree](${RULES_URL}). The label \`${LABEL}\` is removed once it is fixed.`;
}

const API = "https://api.github.com";
const headers = (token) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "krizaka-issue-tree-audit", "content-type": "application/json" });
async function rest(token, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: headers(token), body: body ? JSON.stringify(body) : undefined });
  if (!res.ok && res.status !== 422 && !(method === "DELETE" && res.status === 404)) throw new Error(`${method} ${path}: ${res.status}`);
}
async function gql(token, query, variables) {
  const res = await fetch(`${API}/graphql`, { method: "POST", headers: headers(token), body: JSON.stringify({ query, variables }) });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
  return json.data;
}

const ITEMS = `query($org:String!,$n:Int!,$after:String){organization(login:$org){projectV2(number:$n){
  items(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{content{__typename ... on Issue{number state repository{name}
    issueType{name} parent{number} labels(first:30){nodes{name}} comments(last:30){nodes{body}}}}}}}}}`;

export async function loadItems(token, org, number) {
  const items = [];
  let after = null;
  for (;;) {
    const p = (await gql(token, ITEMS, { org, n: number, after })).organization.projectV2.items;
    for (const n of p.nodes) {
      const c = n.content;
      if (!c || c.__typename !== "Issue") continue;
      items.push({ key: `${c.repository.name}#${c.number}`, repo: c.repository.name, number: c.number, state: c.state, type: c.issueType?.name ?? null, parent: c.parent?.number ?? null, labels: c.labels.nodes.map((l) => l.name), commented: c.comments.nodes.some((m) => m.body?.includes(MARKER)) });
    }
    if (!p.pageInfo.hasNextPage) break;
    after = p.pageInfo.endCursor;
  }
  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
  const dry = args.includes("--dry");
  const org = arg("--org", "krizaka");
  const baselinePath = arg("--baseline", "issue-tree-baseline.json");
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("issue-tree-audit: GH_TOKEN (the Krizaka Agents app token) is required");

  const items = await loadItems(token, org, Number(arg("--project", "4")));
  const bad = audit(items);
  console.log(`open issues on the board: ${items.filter((i) => i.state === "OPEN").length}; breaking the issue tree: ${bad.length}`);
  for (const b of bad) console.log(`  ${b.key}: missing ${b.problems.join(" + ")}`);

  if (!dry) {
    for (const b of bad) {
      if (!b.commented) await rest(token, "POST", `/repos/${org}/${b.repo}/issues/${b.number}/comments`, { body: commentBody(b.problems) });
      if (!b.labels.includes(LABEL)) {
        await rest(token, "POST", `/repos/${org}/${b.repo}/labels`, { name: LABEL, color: "d93f0b", description: "Needs an issue type or a parent Feature (issue tree audit)" }); // 422 = exists
        await rest(token, "POST", `/repos/${org}/${b.repo}/issues/${b.number}/labels`, { labels: [LABEL] });
      }
    }
    const badKeys = new Set(bad.map((b) => b.key));
    for (const i of items) if (i.labels.includes(LABEL) && !badKeys.has(i.key)) await rest(token, "DELETE", `/repos/${org}/${i.repo}/issues/${i.number}/labels/${LABEL}`);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).count;
  const r = ratchet(bad.length, baseline);
  if (r.lower !== null) console.log(`The count fell from ${baseline} to ${r.lower}: lower "count" in ${baselinePath} to lock the gain.`);
  if (!r.ok) {
    console.error(`issue tree: ${bad.length} issues break the rule, the baseline is ${baseline}. The count only goes down: give the new issue(s) a type and a parent Feature.`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
