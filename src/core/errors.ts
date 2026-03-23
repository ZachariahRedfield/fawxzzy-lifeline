export class LifelineError extends Error {
  readonly code: string;

  constructor(message: string, code = "LIFELINE_ERROR") {
    super(message);
    this.name = "LifelineError";
    this.code = code;
  }
}

export class ManifestLoadError extends LifelineError {
  constructor(message: string) {
    super(message, "MANIFEST_LOAD_ERROR");
    this.name = "ManifestLoadError";
  }
}

export class ValidationError extends LifelineError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class RuntimeStateError extends LifelineError {
  constructor(message: string) {
    super(message, "RUNTIME_STATE_ERROR");
    this.name = "RuntimeStateError";
  }
}

export class ProcessManagerError extends LifelineError {
  constructor(message: string) {
    super(message, "PROCESS_MANAGER_ERROR");
    this.name = "ProcessManagerError";
  }
}
