// Parse the provider usage windows printed by `openclaw models status`.
//
// This is shared with the factory doctor so headroom consumers do not grow a
// second, subtly different copy of the provider-output parsing.

export function parseUsageWindow(modelsOut) {
  const output = String(modelsOut || "");
  const short = output.match(/5h\s+(\d+)%\s+left(?:\s+⏱\s*([^\n·]+))?/i);
  const week = output.match(/Week\s+(\d+)%\s+left(?:\s+⏱\s*([^\n·]+))?/i);

  return {
    shortWindow: short
      ? { percentLeft: Number(short[1]), resetIn: short[2]?.trim() || null }
      : null,
    weekWindow: week
      ? { percentLeft: Number(week[1]), resetIn: week[2]?.trim() || null }
      : null,
  };
}
