import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillMetadata {
  name: string;
  description: string;
}

export interface LoadedSkill {
  name: string;
  description: string;
  body: string;
  filePath: string;
}

interface ParsedSkillFile {
  metadata: Partial<SkillMetadata>;
  body: string;
}

export class SkillLoader {
  private readonly skills = new Map<string, LoadedSkill>();

  constructor(private readonly skillsDir: string) {}

  async load(): Promise<void> {
    this.skills.clear();
    for (const filePath of await findSkillFiles(this.skillsDir)) {
      const text = readFileSync(filePath, "utf8");
      const parsed = parseSkillFile(text);
      const fallbackName = path.basename(path.dirname(filePath));
      const name = parsed.metadata.name?.trim() || fallbackName;
      const description = parsed.metadata.description?.trim() || "";
      this.skills.set(name, {
        name,
        description,
        body: parsed.body.trim(),
        filePath
      });
    }
  }

  loadSync(): void {
    this.skills.clear();
    for (const filePath of findSkillFilesSync(this.skillsDir)) {
      const text = readFileSync(filePath, "utf8");
      const parsed = parseSkillFile(text);
      const fallbackName = path.basename(path.dirname(filePath));
      const name = parsed.metadata.name?.trim() || fallbackName;
      const description = parsed.metadata.description?.trim() || "";
      this.skills.set(name, {
        name,
        description,
        body: parsed.body.trim(),
        filePath
      });
    }
  }

  getDescriptions(): string {
    const descriptions = [...this.skills.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => `- ${skill.name}: ${skill.description}`);
    return descriptions.length > 0 ? descriptions.join("\n") : "- No loadable skills found.";
  }

  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available skills: ${this.listSkills()
        .map((item) => item.name)
        .join(", ")}`;
    }

    return `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
  }

  listSkills(): SkillMetadata[] {
    return [...this.skills.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        name: skill.name,
        description: skill.description
      }));
  }
}

let defaultSkillLoader: SkillLoader | undefined;

export function getDefaultSkillLoader(): SkillLoader {
  if (!defaultSkillLoader) {
    defaultSkillLoader = new SkillLoader(resolveDefaultSkillsDir());
    defaultSkillLoader.loadSync();
  }

  return defaultSkillLoader;
}

export function resetDefaultSkillLoaderForTest(): void {
  defaultSkillLoader = undefined;
}

function parseSkillFile(text: string): ParsedSkillFile {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return {
      metadata: {},
      body: normalized
    };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex < 0) {
    return {
      metadata: {},
      body: normalized
    };
  }

  const frontmatter = normalized.slice(3, endIndex).trim();
  const body = normalized.slice(endIndex + "\n---".length).trim();
  return {
    metadata: parseYamlFrontmatter(frontmatter),
    body
  };
}

function parseYamlFrontmatter(frontmatter: string): Partial<SkillMetadata> {
  const metadata: Partial<SkillMetadata> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (key === "name") {
      metadata.name = value;
    }
    if (key === "description") {
      metadata.description = value;
    }
  }

  return metadata;
}

async function findSkillFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }

  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSkillFiles(entryPath)));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function findSkillFilesSync(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSkillFilesSync(entryPath));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function resolveDefaultSkillsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "apps/server/skills"),
    path.resolve(process.cwd(), "skills"),
    path.resolve(moduleDir, "../../skills")
  ];

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}
