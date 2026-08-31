export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor(public readonly partial?: {
    threadId: string | null;
    usage: import("./types.js").RunUsage | null;
    output: string | null;
  }) {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class RunnerExecutionError extends Error {
  constructor(
    message: string,
    public readonly partial: {
      threadId: string | null;
      usage: import("./types.js").RunUsage | null;
      output: string | null;
    },
  ) {
    super(message);
    this.name = "RunnerExecutionError";
  }
}
