import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type MemoryRow = {
  id: string;
  content: string;
  scope: string;
  importance: number;
};

export type MemoryStats = {
  scopes: Array<{ scope: string; count: number }>;
  events: Array<{ kind: string; count: number }>;
};

export type ArtifactRow = {
  id: string;
  name: string;
  mimeType: string | null;
  size: number | null;
};

/**
 * One file, with the text inside it.
 *
 * The list endpoint deliberately carries no content: a hundred files of prose is a payload nobody
 * should download to read one row's name. So the content is a second read, made when a file is
 * actually opened.
 */
export type ArtifactDetail = ArtifactRow & {
  content: string;
};

export type TaskRow = {
  id: string;
  title: string;
  status: string;
  importance: string;
  sourceApp: string | null;
};

export type ScheduleRow = {
  id: string;
  botId?: string | null;
  name: string;
  expression: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  failures: number;
  prompt?: string | null;
};

async function get<T>(path: string, fallback: string): Promise<T> {
  const response = await client(path, { fallback });
  return response.json();
}

export function memoriesQueryOptions() {
  return queryOptions({
    queryKey: ["remi", "memories"] as const,
    queryFn: () =>
      get<{ memories: MemoryRow[] }>(
        "/api/remi/memories",
        "Memories could not be loaded.",
      ),
  });
}

export function memorySearchQueryOptions(query: string) {
  return queryOptions({
    queryKey: ["remi", "memories", "search", query] as const,
    queryFn: () =>
      get<{ memories: Array<{ id: string; content: string }> }>(
        `/api/remi/memories/search?q=${encodeURIComponent(query)}`,
        "Memory search could not be loaded.",
      ),
    enabled: query.trim().length > 1,
  });
}

export function patchMemoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      content?: string;
      pinned?: boolean;
    }): Promise<unknown> => {
      const response = await client(
        `/api/remi/memories/${encodeURIComponent(input.id)}`,
        {
          method: "PATCH",
          body: {
            ...(input.content !== undefined ? { content: input.content } : {}),
            ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          },
          fallback: "Could not update that memory.",
        },
      );
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "memories"] });
    },
  });
}

export function memoryStatsQueryOptions() {
  return queryOptions({
    queryKey: ["remi", "memories", "stats"] as const,
    queryFn: () =>
      get<MemoryStats>(
        "/api/remi/memories/stats",
        "Memory stats could not be loaded.",
      ),
  });
}

export function deleteMemoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      const response = await client(
        `/api/remi/memories/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          fallback: "Could not forget that.",
        },
      );
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "memories"] });
    },
  });
}

export function artifactsQueryOptions() {
  return queryOptions({
    queryKey: ["remi", "artifacts"] as const,
    queryFn: () =>
      get<{ artifacts: ArtifactRow[] }>(
        "/api/remi/artifacts",
        "Files could not be loaded.",
      ),
  });
}

export function artifactQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["remi", "artifacts", id] as const,
    enabled: id.length > 0,
    queryFn: () =>
      get<{ artifact: ArtifactDetail }>(
        `/api/remi/artifacts/${encodeURIComponent(id)}`,
        "That file could not be opened.",
      ),
  });
}

/**
 * Read one file's text, for the moment somebody asks to take it away.
 *
 * The list carries no content on purpose, so a row's Download button is a
 * second read rather than something the row already had. A function rather than
 * a mutation because nothing on screen is waiting for it and nothing is left
 * behind when it lands.
 */
/**
 * Where a saved file's BYTES are, for a viewer or a download.
 *
 * A separate URL from the detail query, and it has to be one: that query answers with the extracted
 * text, which is what a person reading a note wants, and it is capped at 100,000 characters — so it
 * cannot carry an image, a video, or a spreadsheet's worth of cells. This is the same file, streamed
 * from the same row, behind the same ownership check.
 *
 * Relative on purpose, and NOT a bucket URL. The server proxies the bytes so access is re-decided on
 * every fetch; a URL signed for an hour would hand the file to anyone holding it for that hour, with
 * no check that they were ever a member of the channel it belongs to. See `createS3BlobStore`.
 */
/**
 * Send a file the person picked, to be stored whole.
 *
 * `XMLHttpRequest` rather than `fetch`, and the reason is upload progress. `fetch` still cannot
 * report how much of a body has been sent, and a 200 MB video on a slow link is a spinner with no
 * explanation for a minute; an upload with no progress is indistinguishable from a hung app.
 */
export function uploadArtifact(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ id: string; name: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.set("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", "/api/remi/artifacts");
    request.withCredentials = true;

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          const body = JSON.parse(request.responseText) as {
            artifact?: { id: string; name: string };
          };
          if (body.artifact) resolve(body.artifact);
          else reject(new Error("That file could not be saved."));
        } catch {
          reject(new Error("That file could not be saved."));
        }
        return;
      }
      /*
       * THE SERVER'S OWN REASON, NOT A GENERIC ONE.
       *
       * Every refusal from that route is written for the person who pressed the button — an SVG, a
       * file too large, a type this app cannot read — and replacing it with "upload failed" throws
       * away the only sentence that tells them what to do differently.
       */
      try {
        const body = JSON.parse(request.responseText) as { error?: string };
        reject(new Error(body.error ?? "That file could not be saved."));
      } catch {
        reject(new Error("That file could not be saved."));
      }
    });
    request.addEventListener("error", () =>
      reject(new Error("That file could not be sent.")),
    );
    request.addEventListener("abort", () =>
      reject(new Error("The upload was cancelled.")),
    );
    request.send(form);
  });
}

export function artifactContentUrl(id: string): string {
  return `/api/remi/artifacts/${encodeURIComponent(id)}/content`;
}

export async function fetchArtifactText(id: string): Promise<ArtifactDetail> {
  const response = await client(
    `/api/remi/artifacts/${encodeURIComponent(id)}`,
    {
      fallback: "That file could not be read.",
    },
  );
  const body = (await response.json()) as { artifact?: ArtifactDetail };
  if (!body.artifact) {
    throw new Error("That file could not be read.");
  }
  return body.artifact;
}

export function deleteArtifactMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      const response = await client(
        `/api/remi/artifacts/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          fallback: "Could not delete that file.",
        },
      );
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "artifacts"] });
    },
  });
}

export function tasksQueryOptions() {
  return queryOptions({
    queryKey: ["remi", "tasks"] as const,
    queryFn: () =>
      get<{ tasks: TaskRow[] }>(
        "/api/remi/tasks",
        "Tasks could not be loaded.",
      ),
  });
}

export function addTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { title: string }) => {
      const response = await client("/api/remi/tasks", {
        method: "POST",
        body: input,
        fallback: "Could not add that task.",
      });
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "tasks"] });
    },
  });
}

export function updateTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      status?: string;
      resultSummary?: string;
    }) => {
      const response = await client(
        `/api/remi/tasks/${encodeURIComponent(input.id)}`,
        {
          method: "POST",
          body: { status: input.status, resultSummary: input.resultSummary },
          fallback: "Could not update that task.",
        },
      );
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "tasks"] });
    },
  });
}

export function deleteTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      const response = await client(
        `/api/remi/tasks/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          fallback: "Could not delete that task.",
        },
      );
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "tasks"] });
    },
  });
}

export function schedulesQueryOptions() {
  return queryOptions({
    queryKey: ["remi", "schedules"] as const,
    queryFn: () =>
      get<{ schedules: ScheduleRow[] }>(
        "/api/remi/schedules",
        "Schedules could not be loaded.",
      ),
  });
}

export function addScheduleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      name: string;
      expression: string;
      botId?: string | null;
      timezone?: string;
      prompt: string;
    }) => {
      const response = await client("/api/remi/schedules", {
        method: "POST",
        body: input,
        fallback: "Could not schedule that.",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Could not schedule that.");
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "schedules"] });
    },
  });
}

export function updateScheduleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      enabled?: boolean;
      name?: string;
    }) => {
      const response = await client(
        `/api/remi/schedules/${encodeURIComponent(input.id)}`,
        {
          method: "POST",
          body: { enabled: input.enabled, name: input.name },
          fallback: "Could not update that schedule.",
        },
      );
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "schedules"] });
    },
  });
}

export function deleteScheduleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      const response = await client(
        `/api/remi/schedules/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          fallback: "Could not delete that schedule.",
        },
      );
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remi", "schedules"] });
    },
  });
}
