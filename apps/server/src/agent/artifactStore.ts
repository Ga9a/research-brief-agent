import { randomUUID } from "node:crypto";

export type ResearchArtifactKind = "sources" | "synthesis" | "brief";

export interface ResearchArtifact<T = unknown> {
  ref: string;
  kind: ResearchArtifactKind;
  value: T;
  createdAt: string;
  turnId: string;
  researchGoal: string;
}

export interface ResearchArtifactScope {
  turnId?: string;
  researchGoal?: string;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, ResearchArtifact>();

  constructor(initialArtifacts: ResearchArtifact[] = []) {
    for (const artifact of initialArtifacts) {
      this.artifacts.set(artifact.ref, artifact);
    }
  }

  save<T>(kind: ResearchArtifactKind, value: T, scope: Required<ResearchArtifactScope>): ResearchArtifact<T> {
    const artifact: ResearchArtifact<T> = {
      ref: `${kind}:${randomUUID()}`,
      kind,
      value,
      createdAt: new Date().toISOString(),
      turnId: scope.turnId,
      researchGoal: scope.researchGoal
    };
    this.artifacts.set(artifact.ref, artifact);
    return artifact;
  }

  get<T>(ref: string, expectedKind?: ResearchArtifactKind): ResearchArtifact<T> | undefined {
    const artifact = this.artifacts.get(ref);
    if (!artifact) {
      return undefined;
    }

    if (expectedKind && artifact.kind !== expectedKind) {
      return undefined;
    }

    return artifact as ResearchArtifact<T>;
  }

  latest<T>(kind: ResearchArtifactKind, scope: ResearchArtifactScope = {}): ResearchArtifact<T> | undefined {
    return [...this.artifacts.values()]
      .reverse()
      .find((artifact) => artifact.kind === kind && matchesScope(artifact, scope)) as ResearchArtifact<T> | undefined;
  }

  list<T>(kind: ResearchArtifactKind, scope: ResearchArtifactScope = {}): Array<ResearchArtifact<T>> {
    return [...this.artifacts.values()].filter((artifact) => artifact.kind === kind && matchesScope(artifact, scope)) as Array<
      ResearchArtifact<T>
    >;
  }

  listAll(): ResearchArtifact[] {
    return [...this.artifacts.values()];
  }
}

function matchesScope(artifact: ResearchArtifact, scope: ResearchArtifactScope): boolean {
  if (scope.turnId && artifact.turnId !== scope.turnId) {
    return false;
  }

  if (scope.researchGoal && artifact.researchGoal !== scope.researchGoal) {
    return false;
  }

  return true;
}
