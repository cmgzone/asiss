import fs from 'fs';
import os from 'os';
import path from 'path';

export interface WorkspaceFolderEntry {
  name: string;
  path: string;
  projectType: string;
  projectMarkers: string[];
}

export class WorkspaceManager {
  private readonly homePath = path.resolve(os.homedir());

  public getDefaultWorkspaceRoot(): string {
    const configured = String(process.env.GITU_PROJECTS_ROOT || '').trim();
    const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
    const root = configured
      ? path.resolve(configured)
      : oneDrive
        ? path.join(path.resolve(oneDrive), 'Documents', 'Gitu Projects')
        : path.join(this.homePath, 'Documents', 'Gitu Projects');

    this.assertAllowed(root);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  public listRoots() {
    const candidates = [
      { label: 'Home', path: this.homePath },
      { label: 'Desktop', path: path.join(this.homePath, 'Desktop') },
      { label: 'Documents', path: path.join(this.homePath, 'Documents') },
      process.env.OneDrive
        ? { label: 'OneDrive', path: path.resolve(process.env.OneDrive) }
        : null,
      { label: 'Gitu Projects', path: this.getDefaultWorkspaceRoot() }
    ].filter(Boolean) as Array<{ label: string; path: string }>;

    const seen = new Set<string>();
    return candidates.filter((item) => {
      const key = this.comparePath(item.path);
      if (seen.has(key) || !this.isExistingDirectory(item.path)) return false;
      seen.add(key);
      return true;
    });
  }

  public listDirectory(requestedPath?: string) {
    const directoryPath = path.resolve(String(requestedPath || this.homePath));
    this.assertAllowed(directoryPath);
    if (!this.isExistingDirectory(directoryPath)) {
      throw new Error('Folder does not exist or is not accessible.');
    }

    const entries: WorkspaceFolderEntry[] = [];
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childPath = path.join(directoryPath, entry.name);
      try {
        const detection = this.detectProject(childPath);
        entries.push({
          name: entry.name,
          path: childPath,
          projectType: detection.type,
          projectMarkers: detection.markers
        });
      } catch {
        // Ignore folders that disappear or cannot be inspected between reads.
      }
    }

    entries.sort((a, b) => {
      if (Boolean(a.projectType) !== Boolean(b.projectType)) return a.projectType ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const currentDetection = this.detectProject(directoryPath);
    const parentPath = path.dirname(directoryPath);
    return {
      path: directoryPath,
      parentPath: this.isAllowed(parentPath) && parentPath !== directoryPath ? parentPath : '',
      projectType: currentDetection.type,
      projectMarkers: currentDetection.markers,
      folders: entries
    };
  }

  public createFolder(parentPath: string, folderName: string): string {
    const parent = path.resolve(String(parentPath || ''));
    this.assertAllowed(parent);
    if (!this.isExistingDirectory(parent)) throw new Error('Parent folder does not exist.');
    const safeName = this.safeFolderName(folderName);
    if (!safeName) throw new Error('Enter a valid folder name.');
    const folderPath = path.join(parent, safeName);
    this.assertAllowed(folderPath);
    fs.mkdirSync(folderPath, { recursive: false });
    return folderPath;
  }

  public createProjectWorkspace(projectName: string, parentPath?: string): string {
    const parent = parentPath
      ? path.resolve(parentPath)
      : this.getDefaultWorkspaceRoot();
    this.assertAllowed(parent);
    fs.mkdirSync(parent, { recursive: true });

    const baseName = this.safeFolderName(projectName) || 'untitled-project';
    const workspacePath = path.join(parent, baseName);
    this.assertAllowed(workspacePath);
    fs.mkdirSync(workspacePath, { recursive: true });
    return workspacePath;
  }

  public getGeneralWorkspace(): string {
    return this.createProjectWorkspace('General Workspace');
  }

  public getGeneralChatsRoot(): string {
    const root = path.join(this.getDefaultWorkspaceRoot(), 'General Chats');
    this.assertAllowed(root);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  public createGeneralConversationWorkspace(conversationId: string): string {
    const safeId = String(conversationId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
    if (!safeId) throw new Error('A valid conversation id is required.');
    return this.createProjectWorkspace(`Chat ${safeId}`, this.getGeneralChatsRoot());
  }

  public isExistingDirectory(directoryPath: string): boolean {
    try {
      return fs.existsSync(directoryPath) && fs.statSync(directoryPath).isDirectory();
    } catch {
      return false;
    }
  }

  public assertAllowed(candidatePath: string) {
    if (!this.isAllowed(candidatePath)) {
      throw new Error('Folder must be inside the signed-in user home directory.');
    }
  }

  private isAllowed(candidatePath: string): boolean {
    const candidate = this.comparePath(path.resolve(candidatePath));
    const root = this.comparePath(this.homePath);
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
  }

  private comparePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private safeFolderName(value: string): string {
    return String(value || '')
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .slice(0, 120);
  }

  private detectProject(directoryPath: string): { type: string; markers: string[] } {
    const markerTypes: Array<[string, string]> = [
      ['.git', 'Git project'],
      ['package.json', 'Node / JavaScript'],
      ['pyproject.toml', 'Python'],
      ['requirements.txt', 'Python'],
      ['Cargo.toml', 'Rust'],
      ['go.mod', 'Go'],
      ['pom.xml', 'Java / Maven'],
      ['build.gradle', 'Java / Gradle'],
      ['composer.json', 'PHP'],
      ['Gemfile', 'Ruby'],
      ['.sln', '.NET']
    ];

    const markers: string[] = [];
    let type = '';
    for (const [marker, markerType] of markerTypes) {
      if (marker === '.sln') {
        let hasSolution = false;
        try {
          hasSolution = fs.readdirSync(directoryPath).some((name) => name.toLowerCase().endsWith('.sln'));
        } catch {
          hasSolution = false;
        }
        if (!hasSolution) continue;
      } else if (!fs.existsSync(path.join(directoryPath, marker))) {
        continue;
      }
      markers.push(marker);
      if (!type || marker !== '.git') type = markerType;
    }
    if (!type && markers.includes('.git')) type = 'Git project';
    return { type, markers };
  }
}

export const workspaceManager = new WorkspaceManager();
