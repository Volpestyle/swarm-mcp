type ExportNode = {
  id: string;
  position?: { x: number; y: number };
};

type ExportEdge = {
  id: string;
  source?: string;
  target?: string;
};

type ExportInput = {
  activeScope: string | null;
  themeProfileId: string;
  nodes: ExportNode[];
  edges: ExportEdge[];
};

export function buildUiExportPayload(input: ExportInput) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    activeScope: input.activeScope,
    themeProfileId: input.themeProfileId,
    nodes: input.nodes.map((node) => ({
      id: node.id,
      position: node.position ?? null,
    })),
    edges: input.edges.map((edge) => ({
      id: edge.id,
      source: edge.source ?? null,
      target: edge.target ?? null,
    })),
  };
}
