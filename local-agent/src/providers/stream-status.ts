/**
 * What an HTTP status on the reply request means for the person waiting.
 *
 * The provider's reply arrives over one request. When that request fails, the
 * reply never comes - and today the step simply waits out its whole timeout,
 * five minutes, and then reports that the model was slow. It was not slow. It
 * was never asked, or it refused at the transport level.
 *
 * This reads the status code and nothing else. No payload is inspected and no
 * message is pattern-matched: a rate limit is a 429 whatever the body says, and
 * guessing at a body we have never seen is how this project's every serious bug
 * started. A refusal of CONTENT is deliberately not covered here - that comes
 * back as an ordinary successful reply whose prose declines, with the same
 * status and the same stream, so there is nothing structural to read.
 */

export interface StreamFailure {
  /** Shown to the user. Says what happened and what to do about it. */
  message: string;
  /** True when waiting longer cannot help, so the step should stop now. */
  fatal: boolean;
}

/**
 * Null when the request is fine, otherwise what went wrong.
 *
 * 0 is not a failure: XHR reports it before headers arrive and for requests
 * the browser handled without a status, and treating that as an error would
 * fail every healthy reply.
 */
export function describeStreamFailure(status: number | undefined): StreamFailure | null {
  const code = Number(status);
  if (!Number.isFinite(code) || code === 0) return null;
  if (code >= 200 && code < 300) return null;

  if (code === 429) {
    return {
      message: "The provider is rate limiting this account (HTTP 429). Wait a few " +
        "minutes and run the step again - nothing is wrong with the code.",
      fatal: true,
    };
  }
  if (code === 401 || code === 403) {
    return {
      message: "The provider rejected the request as unauthenticated (HTTP " + code +
        "). The session has probably expired - sign in again from the account panel.",
      fatal: true,
    };
  }
  if (code >= 500) {
    return {
      message: "The provider returned a server error (HTTP " + code +
        "). This is their end, not the code - try the step again shortly.",
      fatal: true,
    };
  }
  return {
    message: "The reply request failed with HTTP " + code +
      ", so no answer is coming. Waiting will not help.",
    fatal: true,
  };
}
