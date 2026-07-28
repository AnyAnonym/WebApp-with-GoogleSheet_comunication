class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function errorData(error, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof AppError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return {
    success: false,
    error: {
      code: fallbackCode,
      message: "Interner Serverfehler",
    },
  };
}

module.exports = { AppError, errorData };
