#pragma once

#include <QString>

/*
 * Where the app finds Node and the agent, and where it may write.
 *
 * Each lookup takes an environment override first, so a developer or a test
 * can point the app anywhere without rebuilding it.
 */
namespace Paths {

/*
 * The same directory as Electron's userData, so the two apps share sessions,
 * settings and browser profiles while both ship. CLOSENI_STORAGE overrides it.
 */
QString storageRoot();

/*
 * Node to run the agent with: CLOSENI_NODE, then the copy bundled beside the
 * app, then the first `node` on PATH. Empty when there is none.
 */
QString nodePath();

/*
 * local-agent/dist/index.js: CLOSENI_AGENT, then the bundled copy, then the
 * repository the build directory sits in. Empty when there is none.
 */
QString agentPath();

/* True when agentPath() is the copy bundled with the app, not a checkout. */
bool agentIsBundled();

}
