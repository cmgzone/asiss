declare class AdmZip {
  constructor(input?: string | Buffer);
  extractAllTo(targetPath: string, overwrite: boolean): void;
}

export = AdmZip;
