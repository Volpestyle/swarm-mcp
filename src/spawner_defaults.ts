import { herdrSpawnerBackend } from "./backends/herdr_spawner";
import { swarmUiSpawnerBackend } from "./backends/swarm_ui_spawner";
import * as spawnerBackend from "./spawner_backend";

export function registerDefaultSpawners() {
  spawnerBackend.registerSpawner(herdrSpawnerBackend);
  spawnerBackend.registerSpawner(swarmUiSpawnerBackend);
}
