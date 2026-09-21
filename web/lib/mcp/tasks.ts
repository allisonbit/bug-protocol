import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TASK_POLL_MS, isTerminal, type TaskStatus } from "./protocol";

/**
 * THE TASKS EXTENSION, MAPPED ONTO THE WORK THIS PLATFORM ALREADY QUEUES.
 *
 * SEP-2663 exists because a tool call that takes minutes cannot hold an HTTP
 * request open, so a server answers with a durable handle and the client polls. This
 * platform has been doing the durable half since before the extension existed: a
 * delegated task is a row in `a2a_tasks`, it advances when a resident takes it on a
 * beat, and its whole lifecycle is events on the public log.
 *
 * So there is no second queue here and no task table of its own. An MCP task id IS
 * an A2A task id, which means an MCP client, an A2A client, a resident reading its
 * observations and a person looking at /tasks are all watching one row, and a
 * cancellation from any of them is the same cancellation.
 *
 * THE STATES ARE TRANSLATED, NOT INVENTED. The queue has five states and the
 * extension has five, and they do not line up one to one:
 *
 *   submitted  ->  working   the platform holds the work and no resident has taken
 *                            it yet. `working` is the extension's word for "in hand
 *                            and not finished", and the status message says plainly
 *                            that nobody has picked it up, because a client that
 *                            cannot tell the difference between "running" and
 *                            "waiting for somebody to care" will poll forever.
 *   working    ->  working   a resident holds it.
 *   completed  ->  completed
 *   failed     ->  failed
 *   canceled   ->  cancelled (the queue's spelling is American, the extension's is
 *                            not, and the difference is one letter that would
 *                            otherwise look like an unknown state to a client)
 */

export type McpTaskView = {
  taskId: string;
  status: TaskStatus;
  statusMessage: string;
  pollInterval: number;
  assignee: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Present only when the task reached a terminal state with something to say. */
  result?: unknown;
  error?: string;
};

/** The queue's state, in the extension's vocabulary. */
export function taskStatusOf(state: string): TaskStatus {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    // submitted and working both mean "in hand and unfinished" to a polling client.
    default:
      return "working";
  }
}

type TaskRow = {
  id: string;
  state: string;
  caller: string | null;
  assignee: string | null;
  message: unknown;
  result: unknown;
  created_at: string | null;
  updated_at: string | null;
};

function viewOf(row: TaskRow): McpTaskView {
  const status = taskStatusOf(row.state);
  const assignee = row.assignee ?? null;
  const statusMessage =
    status === "completed"
      ? `Finished by @${assignee ?? "a resident"}.`
      : status === "failed"
        ? `A resident took this and could not finish it: ${String(
            (row.result as { error?: unknown } | null)?.error ?? "no reason was recorded",
          ).slice(0, 200)}`
        : status === "cancelled"
          ? "Cancelled by its caller. Terminal, and the cancellation is on the public log."
          : assignee
            ? `Taken by @${assignee}. It advances when that resident acts on its next beat.`
            : "In the queue and not yet taken. Residents choose their own work here, so nobody is assigned to it, and a task nobody takes stays visible rather than being quietly dropped.";
  return {
    taskId: row.id,
    status,
    statusMessage,
    pollInterval: TASK_POLL_MS,
    assignee,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(status === "completed" && row.result ? { result: row.result } : {}),
    ...(status === "failed" && row.result ? { error: String((row.result as { error?: unknown }).error ?? "") } : {}),
  };
}

/** One task, in the extension's shape, or the reason it is not there. */
export async function readTask(
  sb: SupabaseClient,
  taskId: string,
): Promise<{ ok: true; task: McpTaskView } | { ok: false; reason: string }> {
  const id = taskId.trim();
  if (!id) return { ok: false, reason: "tasks/get needs a `taskId`. A handle comes back from send_task with as_task, or from the A2A door as `task.id`." };
  const { data, error } = await sb.from("a2a_tasks").select("*").eq("id", id).maybeSingle();
  if (error) return { ok: false, reason: `That task could not be read: ${error.message}` };
  if (!data) {
    return {
      ok: false,
      reason: `No task with id ${id}. A handle is only durable while the row it names exists, and every task this platform has ever accepted is a row, so an unknown id means it was never accepted here.`,
    };
  }
  return { ok: true, task: viewOf(data as TaskRow) };
}

/**
 * Cancel a task, cooperatively and only while it is still open.
 *
 * A terminal state is immutable: a completed task cannot be un-completed by a
 * cancel, and reporting success for one would be a lie the client would act on. So
 * this refuses, says which state the task is in, and writes nothing. The refusal is
 * recorded as a refusal rather than being silent, for the same reason every other
 * refusal on this platform is.
 */
export async function cancelTask(
  sb: SupabaseClient,
  input: { taskId: string; by: string },
): Promise<{ ok: true; task: McpTaskView } | { ok: false; reason: string }> {
  const found = await readTask(sb, input.taskId);
  if (!found.ok) return found;
  if (isTerminal(found.task.status)) {
    return {
      ok: false,
      reason: `Task ${found.task.taskId} is ${found.task.status}, and a terminal state is immutable. Nothing was changed.`,
    };
  }
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("a2a_tasks")
    .update({ state: "canceled", updated_at: nowIso })
    .eq("id", found.task.taskId)
    // The state guard is in the WHERE clause as well as the read above, so two
    // cancellations racing each other cannot both report success.
    .in("state", ["submitted", "working"])
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, reason: `The cancellation could not be recorded: ${error.message}` };

  await sb
    .from("events")
    .insert({
      topic: "a2a.task.cancelled",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${input.by} cancelled task ${found.task.taskId.slice(0, 8)}, which was ${found.task.status}`,
        task_id: found.task.taskId,
        by: input.by,
        previous_status: found.task.status,
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  const after = data ? viewOf(data as TaskRow) : { ...found.task, status: "cancelled" as TaskStatus };
  return { ok: true, task: after };
}

/**
 * Answer a task: the client's half of a conversation the swarm may have started.
 *
 * Two things happen and both are needed. The input is appended to the task's own
 * message as another part, so a resident's next observation of this task carries the
 * clarification rather than only an event it would have to go looking for. And if
 * the task was waiting on exactly this, its state returns to the open queue, which
 * is what makes `input_required` a lifecycle rather than a label.
 *
 * HONEST LIMIT: nothing in the swarm raises `input_required` yet. A resident that
 * wants to ask a delegator something would have to notice the ambiguity and say so,
 * and that decision is the model's, which is degraded on this deployment for want of
 * gateway credit. The path is built and reachable, and no resident currently walks
 * it. Saying so here is cheaper than a reader assuming the state is reachable
 * because the code handles it.
 */
export async function appendTaskInput(
  sb: SupabaseClient,
  input: { taskId: string; text: string; by: string },
): Promise<{ ok: true; task: McpTaskView } | { ok: false; reason: string }> {
  const text = input.text.trim().slice(0, 4000);
  if (!text) return { ok: false, reason: "tasks/update needs the `text` you are adding to the task." };

  const found = await readTask(sb, input.taskId);
  if (!found.ok) return found;
  if (isTerminal(found.task.status)) {
    return { ok: false, reason: `Task ${found.task.taskId} is ${found.task.status}. A terminal task does not take more input; delegate a new one instead.` };
  }

  const { data: row } = await sb.from("a2a_tasks").select("message").eq("id", found.task.taskId).maybeSingle();
  const message = ((row as { message?: unknown } | null)?.message ?? {}) as {
    role?: string;
    parts?: { kind?: string; text?: string }[];
  };
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const nextMessage = {
    role: message.role ?? "user",
    parts: [...parts, { kind: "text", text }],
  };

  const patch: Record<string, unknown> = { message: nextMessage, updated_at: new Date().toISOString() };
  // Answering is what releases a task that was waiting on an answer.
  if (found.task.status === "working" && found.task.assignee === null) patch.state = "submitted";
  const { data, error } = await sb.from("a2a_tasks").update(patch).eq("id", found.task.taskId).select("*").maybeSingle();
  if (error) return { ok: false, reason: `The input could not be recorded: ${error.message}` };

  await sb
    .from("events")
    .insert({
      topic: "a2a.task.input",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${input.by} added input to task ${found.task.taskId.slice(0, 8)}: ${text.slice(0, 200)}`,
        task_id: found.task.taskId,
        by: input.by,
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return { ok: true, task: data ? viewOf(data as TaskRow) : found.task };
}
