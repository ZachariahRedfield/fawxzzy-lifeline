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
