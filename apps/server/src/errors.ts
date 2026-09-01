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
  constructor(public readonly threadId: string | null = null) {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class RunFailedError extends Error {
  constructor(
    message: string,
    public readonly threadId: string | null,
  ) {
    super(message);
    this.name = "RunFailedError";
  }
}
