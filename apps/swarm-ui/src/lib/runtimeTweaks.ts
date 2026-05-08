export type RuntimeTweakCommand =
  | {
      kind: 'move';
      featureId: string;
      label: string;
      axis: 'x' | 'y';
      delta: number;
    }
  | {
      kind: 'resize';
      featureId: string;
      label: string;
      dimension: 'width' | 'height';
      delta: number;
    }
  | { kind: 'reset'; target: 'current' }
  | { kind: 'accept'; target: 'current' };

export type RuntimeTweakState = {
  pending: RuntimeTweakCommand[];
  accepted: RuntimeTweakCommand[];
};

const MOVE_TARGETS: Record<string, { featureId: string; label: string }> = {
  'majordomo button': {
    featureId: 'majordomo.ask-button',
    label: 'Majordomo button',
  },
};

const RESIZE_TARGETS: Record<string, { featureId: string; label: string }> = {
  'note surface': {
    featureId: 'canvas.note-document-surface',
    label: 'Note surface',
  },
};

const DIRECTIONS: Record<string, { axis: 'x' | 'y'; sign: number }> = {
  right: { axis: 'x', sign: 1 },
  left: { axis: 'x', sign: -1 },
  down: { axis: 'y', sign: 1 },
  up: { axis: 'y', sign: -1 },
};

const SIZES: Record<string, { dimension: 'width' | 'height'; sign: number }> = {
  wider: { dimension: 'width', sign: 1 },
  narrower: { dimension: 'width', sign: -1 },
  taller: { dimension: 'height', sign: 1 },
  shorter: { dimension: 'height', sign: -1 },
};

export function parseRuntimeTweakCommand(input: string): RuntimeTweakCommand {
  const tokens = input.trim().toLowerCase().split(/\s+/);
  if (tokens[0] !== '/tweak') {
    throw new Error('tweak command must start with /tweak');
  }
  if (tokens[1] === 'reset' && tokens[2] === 'current') return { kind: 'reset', target: 'current' };
  if (tokens[1] === 'accept' && tokens[2] === 'current') return { kind: 'accept', target: 'current' };

  if (tokens[1] === 'move') {
    const amount = Number(tokens[tokens.length - 1]);
    const direction = DIRECTIONS[tokens[tokens.length - 2] ?? ''];
    const targetKey = tokens.slice(2, -2).join(' ');
    const target = MOVE_TARGETS[targetKey];
    if (!target || !direction || !Number.isFinite(amount)) {
      throw new Error('unsupported move tweak');
    }
    return {
      kind: 'move',
      featureId: target.featureId,
      label: target.label,
      axis: direction.axis,
      delta: direction.sign * amount,
    };
  }

  if (tokens[1] === 'resize') {
    const amount = Number(tokens[tokens.length - 1]);
    const size = SIZES[tokens[tokens.length - 2] ?? ''];
    const targetKey = tokens.slice(2, -2).join(' ');
    const target = RESIZE_TARGETS[targetKey];
    if (!target || !size || !Number.isFinite(amount)) {
      throw new Error('unsupported resize tweak');
    }
    return {
      kind: 'resize',
      featureId: target.featureId,
      label: target.label,
      dimension: size.dimension,
      delta: size.sign * amount,
    };
  }

  throw new Error('unsupported tweak command');
}

export function applyRuntimeTweakState(state: RuntimeTweakState, command: RuntimeTweakCommand): RuntimeTweakState {
  if (command.kind === 'reset') {
    return { pending: [], accepted: state.accepted };
  }
  if (command.kind === 'accept') {
    return { pending: [], accepted: [...state.accepted, ...state.pending] };
  }
  return { ...state, pending: [...state.pending, command] };
}

export function runtimeTweakCssVariables(state: RuntimeTweakState): Record<string, string> {
  const variables = {
    '--tweak-majordomo-button-x': '0px',
    '--tweak-majordomo-button-y': '0px',
    '--tweak-note-surface-width': '0px',
    '--tweak-note-surface-height': '0px',
  };
  for (const command of [...state.accepted, ...state.pending]) {
    if (command.kind === 'move' && command.featureId === 'majordomo.ask-button') {
      const key = command.axis === 'x' ? '--tweak-majordomo-button-x' : '--tweak-majordomo-button-y';
      variables[key] = `${Number.parseFloat(variables[key]) + command.delta}px`;
    }
    if (command.kind === 'resize' && command.featureId === 'canvas.note-document-surface') {
      const key = command.dimension === 'width' ? '--tweak-note-surface-width' : '--tweak-note-surface-height';
      variables[key] = `${Number.parseFloat(variables[key]) + command.delta}px`;
    }
  }
  return variables;
}
