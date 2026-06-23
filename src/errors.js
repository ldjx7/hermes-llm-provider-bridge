export class HttpError extends Error {
  constructor(statusCode, message, code = "bridge_error") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function errorBody(error) {
  return {
    error: {
      message: error.message || "Unexpected bridge error",
      type: error.code || "bridge_error"
    }
  };
}
