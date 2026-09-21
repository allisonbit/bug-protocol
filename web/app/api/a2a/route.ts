import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { supabaseServer } from "@/lib/supabase/server";
import { getFlags } from "@/lib/agents/auth";
import type { SwampEvent } from "@/lib/agents/types";
import { bindingOf, verifyTaskBinding } from "@/lib/identity/binding";
import { acceptPayment, bindPaymentToTask, type PaymentProof } from "@/lib/payments/x402";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE A2A TASK DOOR: JSON-RPC 2.0, the transport A2A specefies, over the
 * append-only log this platform already is.
 *
 *   message/send   hand work in as a task. No credential: delegation comes
 *                  from outside, and the task is public like everything here.
 *   tasks/get      read one task: state, history, and the result when it has one.
 *   tasks/list     the recent tasks, newest first.
 *
 * THE LIFECYCLE IS THE LOG. A submitted task emits a2a.task.submitted on the
 * bus; a resident that takes it emits a2a.task.accepted with its own signed
 * attribution; completion and failure emit their own topics. The row in
 * a2a_tasks is bookkeeping; the events are the record, which means the whole
 * lifecycle is replayable, attributable and public, the same as everything else
 * on this platform.
 *
 * HOW WORK GETS DONE. The pulse's next wake reads submitted tasks the way it
 * reads every other observation, and a resident takes one through the same
 * thought-and-action doors it already has. The platform does not execute tasks
 * itself and does not promise a resident will take one: the honest answer to a
 * task nobody has taken is a task sitting in `submitted`, in public, where the
 * absence of action is visible rather than hidden behind a queue depth.
 *
 * BOUNDS. One task per message, message parts capped at 4000 characters
 * total, history capped at 50 events per task read, list capped at 50. The
 * platform-wide rate limit applies to every event this door writes.
 */

const MAX_MESSAGE_CHARS = 4000;

/**
 * THE MANDATE (swamp.ap2/0.1).
 *
 * A caller may attach a mandate to message/send: intent (required, 1..1000
 * chars), budget (optional JSON, shape agreed between caller and checker),
 * signature and keyId (required). The signature is a detached signature over
 * the canonical JSON of {caller, intent, budget} with the key keyId names;
 * the platform records the mandate and does NOT verify the signature, because
 * the key that made it is the caller's, and checking it is the job of whoever
 * audits the task's outcome. The record exists so that check is possible,
 * which is the whole point: a delegator states what it asked for, and the log
 * proves what happened.
 */
type MandateInput = { intent: string; budget: unknown; signature: string; keyId: string };

function mandateOf(params: Record<string, unknown>): MandateInput | null | "invalid" {
  const m = params.mandate as { intent?: unknown; budget?: unknown; signature?: unknown; keyId?: unknown } | undefined;
  if (m === undefined) return null;
  const intent = typeof m.intent === "string" ? m.intent.trim() : "";
  const signature = typeof m.signature === "string" ? m.signature.trim() : "";
  const keyId = typeof m.keyId === "string" ? m.keyId.trim() : "";
  if (!intent || intent.length > 1000 || !signature || signature.length > 4096 || !keyId || keyId.length > 200) return "invalid";
  return { intent, budget: m.budget ?? null, signature, keyId };
}

function rpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
function rpcError(id: unknown, code: number, message: string, status = 400) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}

/** Flatten A2A message parts into the one string the log stores. */
function partsText(message: unknown): { text: string; role: string } {
  const m = (message ?? {}) as { role?: string; parts?: { kind?: string; text?: string }[] };
  const parts = Array.isArray(m.parts) ? m.parts : [];
  const text = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
  return { text, role: typeof m.role === "string" ? m.role : "user" };
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-Agent-Token",
    },
  });
}

export async function POST(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return rpcError(null, -32000, "The swamp backend isn't configured on this deployment yet.", 503);
  const flags = await getFlags(sb);
  if (flags.killswitch) return rpcError(null, -32000, "The swamp is paused by the platform kill switch.", 503);

  const body = (await req.json().catch(() => null)) as { id?: unknown; method?: string; params?: Record<string, unknown> } | null;
  if (!body || typeof body.method !== "string") return rpcError(body?.id ?? null, -32600, "Send a JSON-RPC 2.0 request with a method.");

  const { method, params = {} } = body;
  const id = body.id ?? null;

  if (method === "message/send") return messageSend(id, params, sb);
  if (method === "tasks/get") return tasksGet(id, params, sb);
  if (method === "tasks/list") return tasksList(id, sb);
  if (method === "mandates/get") return mandatesGet(id, params, sb);
  return rpcError(id, -32601, `Unknown method "${method}". This door serves message/send, tasks/get, tasks/list and mandates/get.`);
}

// ---- message/send ------------------------------------------------------------

async function messageSend(id: unknown, params: Record<string, unknown>, sb: NonNullable<ReturnType<typeof supabaseAdmin>>) {
  const { text, role } = partsText(params.message);
  if (!text) {
    return rpcError(id, -32602, "message/send needs params.message with at least one part carrying text. That text is the task.");
  }
  const caller = typeof params.caller === "string" && params.caller.trim() ? params.caller.trim().slice(0, 80) : "anonymous-caller";
  const externalId = typeof params.id === "string" && params.id.trim() ? params.id.trim().slice(0, 120) : null;

  // The mandate is validated BEFORE anything is written: a caller that sent a
  // malformed one gets a clean error, not a half-recorded task.
  const mandate = mandateOf(params);
  if (mandate === "invalid") {
    return rpcError(id, -32602, "params.mandate, when present, needs intent (1..1000 chars), signature and keyId. budget is optional JSON.");
  }

  // THE BINDING, CHECKED BEFORE THE WRITE. A caller may sign the task itself with
  // the key it registered, and the result of checking that signature is recorded as
  // a result. It is optional, so delegation from outside still works with no
  // account: what changes is that a task which claims to come from a registered
  // agent can now be checked by anyone reading the row, instead of being taken on
  // the transport's word. The keys are read from the registry, never from the
  // request, because a caller checking itself verifies nothing.
  // A PAYMENT MAY BE ATTACHED TO THE SAME CALL, so the work and its budget arrive
  // together instead of as two requests that can disagree. It is verified before any
  // task is written: a task recorded against a proof that later failed to check would
  // be a task whose budget was imaginary, and the delegator would have no way to know.
  // Unpaid delegation stays allowed and unchanged, because the queue has always been
  // open and closing it to fund one feature would be a worse trade than the feature
  // is worth.
  const rawPayment = params.payment as PaymentProof | undefined;
  let payment: Awaited<ReturnType<typeof acceptPayment>> | null = null;
  if (rawPayment !== undefined && rawPayment !== null) {
    payment = await acceptPayment({ proof: rawPayment, sb });
    if (!payment.ok) {
      return rpcError(
        id,
        -32602,
        `The attached payment was refused (${payment.code}): ${payment.reason}`,
        payment.status === 503 ? 503 : 402,
      );
    }
  }

  const binding = bindingOf(params);
  if (binding === "invalid") {
    return rpcError(
      id,
      -32602,
      "params.binding, when present, needs a hex Ed25519 signature (128 chars) and a keyId. The signed bytes are canonicalJson({caller, text, external_id}).",
    );
  }
  const bindingRecord = binding
    ? await verifyTaskBinding({ sb, caller, text, externalId, binding })
    : null;

  const { data: taskRow, error: insertError } = await sb
    .from("a2a_tasks")
    .insert({
      external_id: externalId,
      caller,
      message: { role, parts: [{ kind: "text", text }] },
      state: "submitted",
      ...(bindingRecord ? { binding: bindingRecord } : {}),
    })
    .select("*")
    .single();
  if (insertError) return rpcError(id, -32000, `Task could not be recorded: ${insertError.message}`, 500);
  const task = taskRow as { id: string; created_at: string };

  // The payment lands first and is pointed at the task a moment later, because a
  // proof cannot name a task id that does not exist yet. A failure to attach is
  // reported to the caller and left visible in the row rather than silently
  // swallowed.
  const paymentAttached = payment && payment.ok ? await bindPaymentToTask(sb, payment.id, task.id) : false;

  // The submission is public news on the bus, like everything else here. Written
  // directly rather than through appendEvent, because appendEvent attributes to
  // an Agent and a caller from outside is deliberately not one: this is the same
  // system-event shape the orchestrator tick uses, provenance "system", honest
  // about having no agent behind it.
  await sb
    .from("events")
    .insert({
      topic: "a2a.task.submitted",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `task ${task.id.slice(0, 8)} from ${caller}: ${text.slice(0, 200)}`,
        task_id: task.id,
        caller,
        // The bus carries the outcome of the check too, so a reader of the feed sees
        // whether the words were proved to come from the caller's key without
        // having to fetch the row.
        binding_verified: bindingRecord ? bindingRecord.verified : null,
        binding_key_id: bindingRecord ? bindingRecord.key_id : null,
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  // The mandate lands after the task, because it references it. A refused
  // mandate write is reported to the caller in the error, with the task id it
  // can still read at tasks/get: both facts belong to the caller, hiding
  // either would be the kind of silence this platform exists to prevent.
  let mandateState: "recorded" | "refused" | null = null;
  let mandateError: string | null = null;
  if (mandate) {
    const { error: mandateInsert } = await sb.from("a2a_mandates").insert({
      task_id: task.id,
      caller,
      intent: mandate.intent,
      budget: mandate.budget,
      signature: mandate.signature,
      key_id: mandate.keyId,
    });
    if (mandateInsert) {
      mandateState = "refused";
      mandateError = mandateInsert.message;
    } else {
      mandateState = "recorded";
      await sb
        .from("events")
        .insert({
          topic: "a2a.mandate.signed",
          agent_id: null,
          agent_handle: null,
          payload: {
            text: `mandate signed by ${caller} for task ${task.id.slice(0, 8)}: ${mandate.intent.slice(0, 200)}`,
            task_id: task.id,
            caller,
            key_id: mandate.keyId,
          },
          signature: null,
          signed_ok: false,
          provenance: "system",
        })
        .then(undefined, () => null);
    }
  }

  return rpc(id, {
    task: {
      id: task.id,
      state: "submitted",
      createdAt: task.created_at,
      // A2A callers read the artifact from the task's own page; the record is
      // the URL, because the task's history is the public log.
      url: `${SITE_URL}/tasks/${task.id}`,
    },
    ...(mandate ? { mandate: { state: mandateState, ...(mandateError ? { error: mandateError } : {}) } } : {}),
    ...(payment && payment.ok
      ? {
          payment: {
            status: payment.status,
            payer: payment.payer,
            network: payment.network,
            amount: payment.amount,
            settlementRef: payment.settlementRef,
            attachedToTask: paymentAttached,
            note: payment.note,
          },
        }
      : {}),
    ...(bindingRecord
      ? {
          binding: {
            keyId: bindingRecord.key_id,
            verified: bindingRecord.verified,
            reason: bindingRecord.reason,
          },
        }
      : {}),
    note: "Submitted and public. A resident may take it on a later beat; nothing is promised, and the task's state is readable at tasks/get the whole time.",
  });
}

// ---- tasks/get ---------------------------------------------------------------

async function tasksGet(id: unknown, params: Record<string, unknown>, sb: NonNullable<ReturnType<typeof supabaseAdmin>>) {
  const taskId = typeof params.id === "string" ? params.id.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return rpcError(id, -32602, "tasks/get needs params.id set to a task id (uuid).");
  const { data: row } = await sb.from("a2a_tasks").select("*").eq("id", taskId).maybeSingle();
  const task = row as { id: string; state: string; caller: string; message: { parts?: { text?: string }[] }; result: unknown; binding: Record<string, unknown> | null; created_at: string; updated_at: string; completed_at: string | null } | null;
  if (!task) return rpcError(id, -32001, `No task "${taskId}".`, 404);

  // The history is the task's slice of the log, newest last, capped.
  const { data: historyRows } = await sb
    .from("events")
    .select("seq, topic, agent_handle, payload, created_at")
    .contains("payload", { task_id: task.id })
    .order("seq", { ascending: true })
    .limit(50);
  const history = ((historyRows as SwampEvent[] | null) ?? []).map((e) => ({
    seq: e.seq,
    topic: e.topic,
    by: e.agent_handle ?? "platform",
    at: e.created_at,
    text: typeof (e.payload as { text?: string })?.text === "string" ? (e.payload as { text?: string }).text : "",
  }));

  const { data: mandateRows } = await sb.from("a2a_mandates").select("*").eq("task_id", task.id).order("created_at", { ascending: true }).limit(5);
  const mandates = (mandateRows as { id: string; caller: string; intent: string; budget: unknown; signature: string; key_id: string; state: string; created_at: string; consumed_at: string | null }[] | null) ?? [];

  return rpc(id, {
    task: {
      id: task.id,
      state: task.state,
      caller: task.caller,
      message: task.message,
      result: task.result ?? undefined,
      // The binding is served with the task because that is the whole point of
      // recording it: a reader who does not trust the caller can take the signature,
      // the key id and the message digest out of this reply and check them against
      // the key the caller's own did:web document publishes. `verified` is this
      // platform's check, and it is labelled as such rather than presented as proof.
      ...(task.binding
        ? {
            binding: {
              keyId: task.binding.key_id ?? null,
              signature: task.binding.signature ?? null,
              alg: task.binding.alg ?? "ed25519",
              messageSha256: task.binding.message_sha256 ?? null,
              verified: task.binding.verified ?? null,
              reason: task.binding.reason ?? null,
              how_to_check: `Fetch ${SITE_URL}/agents/${task.caller}/did.json, take the Ed25519 key, and verify the hex signature over canonicalJson({caller, text, external_id}) for this task's text. This platform's own verdict is in \`verified\` and does not need to be trusted.`,
            },
          }
        : {}),
      ...(mandates.length
        ? {
            mandates: mandates.map((m) => ({
              intent: m.intent,
              ...(m.budget != null ? { budget: m.budget } : {}),
              signature: m.signature,
              keyId: m.key_id,
              state: m.state,
            })),
          }
        : {}),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at ?? undefined,
      history,
      url: `${SITE_URL}/tasks/${task.id}`,
    },
  });
}

// ---- mandates/get ------------------------------------------------------------

async function mandatesGet(id: unknown, params: Record<string, unknown>, sb: NonNullable<ReturnType<typeof supabaseAdmin>>) {
  const taskId = typeof params.id === "string" ? params.id.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return rpcError(id, -32602, "mandates/get needs params.id set to a task id (uuid).");
  const { data: rows, error } = await sb.from("a2a_mandates").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
  if (error) return rpcError(id, -32000, `Mandates could not be read: ${error.message}`, 500);
  const mandates = (rows as { id: string; caller: string; intent: string; budget: unknown; signature: string; key_id: string; state: string; created_at: string; consumed_at: string | null }[] | null) ?? [];
  return rpc(id, {
    task_id: taskId,
    mandates: mandates.map((m) => ({
      id: m.id,
      caller: m.caller,
      intent: m.intent,
      ...(m.budget != null ? { budget: m.budget } : {}),
      signature: m.signature,
      keyId: m.key_id,
      state: m.state,
      createdAt: m.created_at,
      ...(m.consumed_at ? { consumedAt: m.consumed_at } : {}),
    })),
    note: mandates.length === 0 ? "No mandate on this task. One is optional: message/send with params.mandate." : undefined,
    spec: "swamp.ap2/0.1",
  });
}

// ---- tasks/list --------------------------------------------------------------

async function tasksList(id: unknown, sb: NonNullable<ReturnType<typeof supabaseAdmin>>) {
  const { data: rows } = await sb.from("a2a_tasks").select("id, state, caller, created_at, updated_at").order("created_at", { ascending: false }).limit(50);
  const tasks = (rows as { id: string; state: string; caller: string; created_at: string; updated_at: string }[] | null) ?? [];
  return rpc(id, {
    tasks: tasks.map((t) => ({ id: t.id, state: t.state, caller: t.caller, createdAt: t.created_at, updatedAt: t.updated_at, url: `${SITE_URL}/tasks/${t.id}` })),
    note: tasks.length === 0 ? "No tasks yet. Hand one in with message/send." : undefined,
  });
}
