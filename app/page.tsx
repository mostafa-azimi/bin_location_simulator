"use client";

import {
  ChangeEvent,
  CSSProperties,
  ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

type RouteSide = "left" | "right";
type PageKey = "create" | "overhead" | "aisle" | "output";
type SourceMode = "generated" | "uploaded";
type RoutePattern = "serpentine" | "u-shape";
type TrackDirection = "up" | "down" | "u-path";
type ThemeMode = "dark" | "light";
type ViewportSize = {
  width: number;
  height: number;
};

type LayoutConfig = {
  zones: number;
  aisles: number;
  bays: number;
  shelves: number;
  slots: number;
};

type LocationRecord = {
  name: string;
  zoneLabel: string;
  zoneIndex: number;
  aisleLabel: string;
  aisle: number;
  bay: number;
  shelfLabel: string;
  shelfIndex: number;
  slot: number;
  side: RouteSide;
  originalIndex: number;
  zeroPadded: boolean;
  usesTargetPrefix: boolean;
};

type UploadAnalysis = {
  fileName: string;
  totalRows: number;
  validLocations: LocationRecord[];
  invalidNames: string[];
  duplicateNames: string[];
  nonPaddedNames: string[];
  legacyPrefixNames: string[];
  routeBacktracks: string[];
  inferredConfig: LayoutConfig;
};

type OverheadPathStop = {
  zoneIndex: number;
  zoneLabel: string;
  aisle: number;
  aisleLabel: string;
  rowKey: string;
  trackDirection: TrackDirection;
};

const defaultConfig: LayoutConfig = {
  zones: 1,
  aisles: 3,
  bays: 4,
  shelves: 3,
  slots: 4,
};

const inputLimits: Record<keyof LayoutConfig, number> = {
  zones: 6,
  aisles: 24,
  bays: 24,
  shelves: 8,
  slots: 12,
};

const labels: Record<keyof LayoutConfig, string> = {
  zones: "Zones",
  aisles: "Aisles",
  bays: "Bays per side",
  shelves: "Shelves per bay",
  slots: "Slots per shelf",
};

const pageLabels: Array<{ key: PageKey; label: string }> = [
  { key: "create", label: "Create" },
  { key: "overhead", label: "Overhead" },
  { key: "aisle", label: "Aisle" },
  { key: "output", label: "Output" },
];

const routePatternLabels: Record<RoutePattern, string> = {
  serpentine: "Serpentine",
  "u-shape": "U shape",
};

const alphaSort = (a: string, b: string) =>
  a.localeCompare(b, "en-US", { numeric: false, sensitivity: "base" });

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));

const pad2 = (value: number) => String(value).padStart(2, "0");

const totalBayCount = (config: LayoutConfig) => config.bays * 2;

function lettersFromNumber(value: number) {
  let n = value;
  let label = "";

  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }

  return label || "A";
}

function numberFromLetters(value: string) {
  return value
    .toUpperCase()
    .split("")
    .reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function locationName(
  zoneIndex: number,
  aisle: number,
  bay: number,
  shelfIndex: number,
  slot: number,
) {
  return `${pad2(zoneIndex)}${lettersFromNumber(aisle)}-${pad2(
    bay,
  )}-${lettersFromNumber(shelfIndex)}-${pad2(slot)}`;
}

function parseLocationName(name: string, originalIndex: number): LocationRecord | null {
  const cleanName = name.trim();
  const targetMatch = /^(\d+)([A-Za-z]+)-(\d+)-([A-Za-z]+)-(\d+)$/.exec(cleanName);
  const legacyMatch = /^([A-Za-z]+)(\d+)-(\d+)-([A-Za-z]+)-(\d+)$/.exec(cleanName);

  if (!targetMatch && !legacyMatch) {
    return null;
  }

  const usesTargetPrefix = Boolean(targetMatch);
  const parts = targetMatch ?? legacyMatch;

  if (!parts) {
    return null;
  }

  const [, firstPrefixPart, secondPrefixPart, bayRaw, shelfLabelRaw, slotRaw] = parts;
  const zoneRaw = usesTargetPrefix ? firstPrefixPart : secondPrefixPart;
  const aisleRaw = usesTargetPrefix ? secondPrefixPart : firstPrefixPart;
  const zoneIndex = Number.parseInt(zoneRaw, 10);
  const aisle = numberFromLetters(aisleRaw);
  const bay = Number.parseInt(bayRaw, 10);
  const slot = Number.parseInt(slotRaw, 10);
  const shelfIndex = numberFromLetters(shelfLabelRaw);

  return {
    name: cleanName,
    zoneLabel: pad2(zoneIndex),
    zoneIndex,
    aisleLabel: aisleRaw.toUpperCase(),
    aisle,
    bay,
    shelfLabel: shelfLabelRaw.toUpperCase(),
    shelfIndex,
    slot,
    side: bay % 2 === 1 ? "left" : "right",
    originalIndex,
    zeroPadded: zoneRaw.length >= 2 && bayRaw.length >= 2 && slotRaw.length >= 2,
    usesTargetPrefix,
  };
}

function pickCoordinateKey(
  zoneIndex: number,
  aisle: number,
  bay: number,
  shelfIndex: number,
  slot: number,
) {
  return `${zoneIndex}-${aisle}-${bay}-${shelfIndex}-${slot}`;
}

function seededRandom(seed: number) {
  let state = seed || 1;

  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function buildRandomPickStops(
  locations: LocationRecord[],
  count: number,
  seed: number,
) {
  const targetCount = clampNumber(count, 1, Math.max(1, locations.length));

  if (targetCount >= locations.length) {
    return [...locations].sort((a, b) => alphaSort(a.name, b.name));
  }

  const random = seededRandom(seed);
  const picks: LocationRecord[] = [];

  locations.forEach((location, index) => {
    if (index < targetCount) {
      picks.push(location);
      return;
    }

    const swapIndex = Math.floor(random() * (index + 1));
    if (swapIndex < targetCount) {
      picks[swapIndex] = location;
    }
  });

  return picks.sort((a, b) => alphaSort(a.name, b.name));
}

function buildOverheadRows(
  config: LayoutConfig,
  routePattern: RoutePattern,
  aisleDirection: "up" | "down",
) {
  const baysPerSide = config.bays;
  const totalBays = totalBayCount(config);

  if (routePattern === "u-shape") {
    return Array.from({ length: baysPerSide }, (_, index) => ({
      leftBay: baysPerSide - index,
      rightBay:
        baysPerSide + index + 1 <= totalBays
          ? baysPerSide + index + 1
          : null,
    }));
  }

  const pairs = Array.from({ length: baysPerSide }, (_, index) => ({
    odd: index * 2 + 1,
    even: index * 2 + 2 <= totalBays ? index * 2 + 2 : null,
  }));
  const physicalPairs = aisleDirection === "up" ? [...pairs].reverse() : pairs;

  return physicalPairs.map(({ odd, even }) => ({
    leftBay: aisleDirection === "up" ? odd : even,
    rightBay: aisleDirection === "up" ? even : odd,
  }));
}

function overheadRowKey(
  zoneIndex: number,
  aisle: number,
  leftBay: number | null,
  rightBay: number | null,
) {
  return `${zoneIndex}-${aisle}-${leftBay ?? "empty"}-${rightBay ?? "empty"}`;
}

function buildOverheadPath(config: LayoutConfig, routePattern: RoutePattern) {
  const path: OverheadPathStop[] = [];

  for (let zone = 1; zone <= config.zones; zone += 1) {
    for (let aisle = 1; aisle <= config.aisles; aisle += 1) {
      const aisleLabel = lettersFromNumber(aisle);
      const aisleDirection =
        routePattern === "serpentine" && aisle % 2 === 0 ? "down" : "up";
      const rows = buildOverheadRows(config, routePattern, aisleDirection);
      const addStop = (
        row: { leftBay: number | null; rightBay: number | null },
        trackDirection: TrackDirection,
      ) => {
        path.push({
          zoneIndex: zone,
          zoneLabel: pad2(zone),
          aisle,
          aisleLabel,
          rowKey: overheadRowKey(zone, aisle, row.leftBay, row.rightBay),
          trackDirection,
        });
      };

      if (routePattern === "u-shape") {
        [...rows].reverse().forEach((row) => addStop(row, "up"));
        rows.forEach((row) => addStop(row, "down"));
        continue;
      }

      const traversalRows = aisleDirection === "up" ? [...rows].reverse() : rows;
      traversalRows.forEach((row) => addStop(row, aisleDirection));
    }
  }

  return path;
}

function generateLocations(config: LayoutConfig) {
  const locations: LocationRecord[] = [];
  const totalBays = totalBayCount(config);

  for (let zone = 1; zone <= config.zones; zone += 1) {
    for (let aisle = 1; aisle <= config.aisles; aisle += 1) {
      for (let bay = 1; bay <= totalBays; bay += 1) {
        for (let shelf = 1; shelf <= config.shelves; shelf += 1) {
          for (let slot = 1; slot <= config.slots; slot += 1) {
            const parsed = parseLocationName(
              locationName(zone, aisle, bay, shelf, slot),
              locations.length,
            );
            if (parsed) {
              locations.push(parsed);
            }
          }
        }
      }
    }
  }

  return locations.sort((a, b) => alphaSort(a.name, b.name));
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) {
    rows.push(row);
  }

  return rows;
}

function inferConfig(records: LocationRecord[]): LayoutConfig {
  return records.reduce<LayoutConfig>(
    (max, record) => ({
      zones: Math.max(max.zones, record.zoneIndex),
      aisles: Math.max(max.aisles, record.aisle),
      bays: Math.max(max.bays, Math.ceil(record.bay / 2)),
      shelves: Math.max(max.shelves, record.shelfIndex),
      slots: Math.max(max.slots, record.slot),
    }),
    { zones: 1, aisles: 1, bays: 1, shelves: 1, slots: 1 },
  );
}

function analyzeImportedCsv(text: string, fileName: string): UploadAnalysis {
  const rows = parseCsv(text);
  const headers = rows[0]?.map((header) => header.trim().toLowerCase()) ?? [];
  const headerNameIndex = headers.findIndex(
    (header) => header === "name" || header === "location name",
  );
  const nameIndex = headerNameIndex >= 0 ? headerNameIndex : 0;
  const names = rows
    .slice(headers.length > 0 ? 1 : 0)
    .map((row) => row[nameIndex]?.trim() ?? "")
    .filter(Boolean);
  const counts = new Map<string, number>();

  names.forEach((name) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });

  const validLocations = names
    .map((name, index) => parseLocationName(name, index))
    .filter((location): location is LocationRecord => Boolean(location))
    .sort((a, b) => alphaSort(a.name, b.name));

  const invalidNames = names.filter((name, index) => !parseLocationName(name, index));
  const duplicateNames = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  const nonPaddedNames = validLocations
    .filter((location) => !location.zeroPadded)
    .map((location) => location.name);
  const legacyPrefixNames = validLocations
    .filter((location) => !location.usesTargetPrefix)
    .map((location) => location.name);
  const routeBacktracks: string[] = [];

  validLocations.forEach((current, index) => {
    const previous = validLocations[index - 1];
    if (!previous) {
      return;
    }

    const sameZone = current.zoneIndex === previous.zoneIndex;
    const movedBackward =
      sameZone &&
      (current.aisle < previous.aisle ||
        (current.aisle === previous.aisle && current.bay < previous.bay));

    if (movedBackward) {
      routeBacktracks.push(`${previous.name} -> ${current.name}`);
    }
  });

  return {
    fileName,
    totalRows: names.length,
    validLocations,
    invalidNames,
    duplicateNames,
    nonPaddedNames,
    legacyPrefixNames,
    routeBacktracks,
    inferredConfig: inferConfig(validLocations),
  };
}

function csvEscape(value: string) {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function buildShipHeroCsv(locations: LocationRecord[]) {
  const header = ["Name", "Pickable", "Priority", "Type", "Sellable"];
  const rows = locations.map((location) => [
    location.name,
    "Yes",
    "0",
    "Bin",
    "Yes",
  ]);

  return [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HealthPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "good" | "warn" | "bad";
}) {
  return (
    <div className={`health-pill ${tone}`}>
      <strong>{count}</strong>
      <span>{label}</span>
    </div>
  );
}

function PageTabs({
  activePage,
  onChange,
}: {
  activePage: PageKey;
  onChange: (page: PageKey) => void;
}) {
  return (
    <nav className="page-tabs" aria-label="Simulator pages">
      {pageLabels.map((page) => (
        <button
          aria-current={activePage === page.key ? "page" : undefined}
          className={activePage === page.key ? "active" : ""}
          key={page.key}
          onClick={() => onChange(page.key)}
          type="button"
        >
          {page.label}
        </button>
      ))}
    </nav>
  );
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: ThemeMode;
  onChange: (theme: ThemeMode) => void;
}) {
  return (
    <div className="mode-switch theme-switch" aria-label="Color theme">
      <button
        className={theme === "dark" ? "active" : ""}
        onClick={() => onChange("dark")}
        type="button"
      >
        Dark
      </button>
      <button
        className={theme === "light" ? "active" : ""}
        onClick={() => onChange("light")}
        type="button"
      >
        Light
      </button>
    </div>
  );
}

function SourceSwitch({
  mode,
  canUseUploaded,
  onChange,
}: {
  mode: SourceMode;
  canUseUploaded: boolean;
  onChange: (mode: SourceMode) => void;
}) {
  return (
    <div className="mode-switch" aria-label="Simulation source">
      <button
        className={mode === "generated" ? "active" : ""}
        onClick={() => onChange("generated")}
        type="button"
      >
        Generated layout
      </button>
      <button
        className={mode === "uploaded" ? "active" : ""}
        disabled={!canUseUploaded}
        onClick={() => onChange("uploaded")}
        type="button"
      >
        Uploaded CSV
      </button>
    </div>
  );
}

function RoutePatternSwitch({
  routePattern,
  onChange,
}: {
  routePattern: RoutePattern;
  onChange: (routePattern: RoutePattern) => void;
}) {
  return (
    <div className="toolbar-group route-pattern-panel">
      <span className="control-label">Route path</span>
      <div className="mode-switch route-pattern-switch" aria-label="Route path">
        {(Object.keys(routePatternLabels) as RoutePattern[]).map((pattern) => (
          <button
            className={routePattern === pattern ? "active" : ""}
            key={pattern}
            onClick={() => onChange(pattern)}
            type="button"
          >
            {routePatternLabels[pattern]}
          </button>
        ))}
      </div>
    </div>
  );
}

function RandomPickControls({
  pickCount,
  maxCount,
  onPickCountChange,
  onRandomize,
}: {
  pickCount: number;
  maxCount: number;
  onPickCountChange: (pickCount: number) => void;
  onRandomize: () => void;
}) {
  return (
    <div className="toolbar-group random-picks-panel">
      <span className="control-label">Aisle A random picks</span>
      <label className="number-field compact-number-field">
        <span>Locations to highlight</span>
        <input
          max={Math.max(1, maxCount)}
          min={1}
          onChange={(event) =>
            onPickCountChange(Number.parseInt(event.target.value, 10))
          }
          type="number"
          value={pickCount}
        />
      </label>
      <button className="ghost-action compact-action" onClick={onRandomize} type="button">
        New random set
      </button>
    </div>
  );
}

function ViewZoomControls({
  zoom,
  onZoomChange,
}: {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  return (
    <div className="toolbar-group zoom-panel">
      <span className="control-label">View zoom</span>
      <label className="range-field speed-field">
        <span>Zoom</span>
        <input
          max={3}
          min={1}
          onChange={(event) => onZoomChange(Number.parseFloat(event.target.value))}
          onInput={(event) => onZoomChange(Number.parseFloat(event.currentTarget.value))}
          step={0.05}
          type="range"
          value={zoom}
        />
        <strong>{Math.round(zoom * 100)}%</strong>
      </label>
    </div>
  );
}

function PlaybackControls({
  activeLabel,
  activeIndex,
  total,
  isPlaying,
  speedMs,
  onPlayPause,
  onReset,
  onSeek,
  onSpeedChange,
}: {
  activeLabel: string;
  activeIndex: number;
  total: number;
  isPlaying: boolean;
  speedMs: number;
  onPlayPause: () => void;
  onReset: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speedMs: number) => void;
}) {
  return (
    <div className="toolbar-group playback-panel">
      <div className="compact-heading">
        <span className="control-label">{activeLabel}</span>
        <span className="small-badge">{total ? `${activeIndex + 1} / ${total}` : "0 / 0"}</span>
      </div>

      <div className="playback-row">
        <button className="primary-action compact" onClick={onPlayPause} type="button">
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button className="ghost-action" onClick={onReset} type="button">
          Reset
        </button>
      </div>

      <label className="range-field">
        <span>Route position</span>
        <input
          max={Math.max(0, total - 1)}
          min={0}
          onChange={(event) => onSeek(Number.parseInt(event.target.value, 10))}
          type="range"
          value={activeIndex}
        />
      </label>

      <label className="range-field speed-field">
        <span>Speed</span>
        <input
          max={1400}
          min={160}
          onChange={(event) => onSpeedChange(Number.parseInt(event.target.value, 10))}
          step={40}
          type="range"
          value={speedMs}
        />
        <strong>{(speedMs / 1000).toFixed(2)} sec / pick</strong>
      </label>
    </div>
  );
}

function CreatePage({
  config,
  generatedLocations,
  mode,
  canUseUploaded,
  onConfigChange,
  onSourceChange,
}: {
  config: LayoutConfig;
  generatedLocations: LocationRecord[];
  mode: SourceMode;
  canUseUploaded: boolean;
  onConfigChange: (key: keyof LayoutConfig, value: number) => void;
  onSourceChange: (mode: SourceMode) => void;
}) {
  return (
    <div className="page-grid create-grid">
      <section className="panel input-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Warehouse dimensions</p>
            <h2>Create bin locations</h2>
          </div>
        </div>
        <div className="input-grid wide">
          {(Object.keys(config) as Array<keyof LayoutConfig>).map((key) => (
            <label className="number-field" key={key}>
              <span>{labels[key]}</span>
              <input
                max={inputLimits[key]}
                min={1}
                onChange={(event) =>
                  onConfigChange(key, Number.parseInt(event.target.value, 10))
                }
                type="number"
                value={config[key]}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Simulation source</p>
            <h2>Generated or imported</h2>
          </div>
        </div>
        <SourceSwitch
          canUseUploaded={canUseUploaded}
          mode={mode}
          onChange={onSourceChange}
        />
      </section>

      <section className="panel generated-reference-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Generated reference</p>
            <h2>Current layout</h2>
          </div>
        </div>
        <div className="summary-band">
          <Stat
            label="Generated bin locations"
            value={generatedLocations.length.toLocaleString()}
          />
          <Stat label="First location" value={generatedLocations[0]?.name ?? "-"} />
          <Stat
            label="Last location"
            value={generatedLocations[generatedLocations.length - 1]?.name ?? "-"}
          />
        </div>
      </section>
    </div>
  );
}

function OverheadRoute({
  activeIndex,
  controls,
  config,
  speedMs,
  zoom,
  routePattern,
  pathStops,
  viewportSize,
}: {
  activeIndex: number;
  controls: ReactNode;
  config: LayoutConfig;
  speedMs: number;
  zoom: number;
  routePattern: RoutePattern;
  pathStops: OverheadPathStop[];
  viewportSize: ViewportSize;
}) {
  const activePathStop = pathStops[activeIndex];
  const activeZoneIndex = activePathStop?.zoneIndex ?? 1;
  const visitedRows = useMemo(() => {
    const rows = new Set<string>();
    pathStops.slice(0, activeIndex).forEach((stop) => rows.add(stop.rowKey));
    return rows;
  }, [activeIndex, pathStops]);
  const zones = Array.from({ length: config.zones }, (_, index) => index + 1);
  const aisles = Array.from({ length: config.aisles }, (_, index) => index + 1);
  const totalBays = totalBayCount(config);
  const naturalAisleWidth = 128;
  const naturalBayRowHeight = 78;
  const naturalWidth = Math.max(1, config.aisles) * naturalAisleWidth;
  const naturalZoneHeight =
    config.bays * naturalBayRowHeight + (config.zones > 1 ? 36 : 0);
  const naturalHeight =
    Math.max(1, config.zones) * naturalZoneHeight + Math.max(0, config.zones - 1) * 12;
  const availableWidth = Math.max(320, Math.min(1640, viewportSize.width - 68));
  const availableHeight = Math.max(240, viewportSize.height - 370);
  const fitScale = Math.min(
    1,
    availableWidth / naturalWidth,
    availableHeight / naturalHeight,
  );
  const layoutScale = Number((fitScale * zoom).toFixed(3));
  const simulationStyle = {
    "--glide-ms": `${speedMs}ms`,
    "--layout-scale": layoutScale,
  } as CSSProperties;
  const renderBay = (
    bay: number | null,
    key: string,
    className: string,
    style: CSSProperties,
  ) =>
    bay && bay <= totalBays ? (
      <div className={`warehouse-bay ${className}`} key={key} style={style}>
        <span>Bay {pad2(bay)}</span>
      </div>
    ) : (
      <div className={`warehouse-bay empty ${className}`} key={key} style={style} />
    );

  return (
    <section className="panel visualization-panel" style={simulationStyle}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Overhead simulation</p>
          <h2>Warehouse layout</h2>
        </div>
        <span className="small-badge">{routePatternLabels[routePattern]} path</span>
      </div>
      {controls}

      <div className="warehouse-scroll">
        <div className="warehouse-zoom-surface">
          <div
            className="warehouse-outline route-outline"
            style={{ "--zone-count": config.zones } as CSSProperties}
          >
            {zones.map((zone) => {
              const zoneLabel = pad2(zone);

              return (
                <div className="zone-layout" key={zone}>
                  {config.zones > 1 && <div className="zone-label">Zone {zoneLabel}</div>}
                  <div
                    className="route-grid"
                    style={{ gridTemplateColumns: `repeat(${config.aisles}, max-content)` }}
                  >
                    {aisles.map((aisle) => {
                      const aisleLabel = lettersFromNumber(aisle);
                      const direction =
                        routePattern === "serpentine" && aisle % 2 === 0 ? "down" : "up";
                      const rows = buildOverheadRows(config, routePattern, direction);
                      const rowKeys = rows.map(({ leftBay, rightBay }) =>
                        overheadRowKey(zone, aisle, leftBay, rightBay),
                      );
                      const activeRowIndex = rows.findIndex(
                        ({ leftBay, rightBay }) =>
                          activePathStop?.rowKey ===
                          overheadRowKey(zone, aisle, leftBay, rightBay),
                      );
                      const isActiveAisle =
                        activeZoneIndex === zone && activePathStop?.aisle === aisle;
                      const activeTrackDirection =
                        isActiveAisle && activePathStop
                          ? activePathStop.trackDirection
                          : routePattern === "u-shape"
                            ? "u-path"
                            : direction;
                      const completedAisle =
                        rowKeys.length > 0 && rowKeys.every((rowKey) => visitedRows.has(rowKey));
                      const pickerTop =
                        activeRowIndex >= 0
                          ? `${((activeRowIndex + 0.5) / rows.length) * 100}%`
                          : direction === "up"
                            ? "100%"
                            : "0%";

                      return (
                        <div
                          className={`warehouse-aisle route-aisle ${routePattern} ${direction}`}
                          key={aisle}
                        >
                          <div
                            className="route-bay-stack continuous-route-stack"
                            style={
                              {
                                "--picker-top": pickerTop,
                                gridTemplateRows: `repeat(${rows.length}, minmax(72px, 1fr))`,
                              } as CSSProperties
                            }
                          >
                            <div
                              className={`aisle-track continuous-aisle-track ${activeTrackDirection} ${
                                isActiveAisle ? "active" : ""
                              } ${completedAisle ? "done" : ""}`}
                              style={{ gridRow: `1 / span ${rows.length}` }}
                            >
                              <div className="aisle-track-label">
                                <strong>{zoneLabel}{aisleLabel}</strong>
                              </div>
                              {isActiveAisle && (
                                <div className="overhead-picker">
                                  <span>Picker</span>
                                </div>
                              )}
                            </div>

                            {rows.flatMap(({ leftBay, rightBay }, rowIndex) => {
                              const rowKey = overheadRowKey(zone, aisle, leftBay, rightBay);
                              const isActivePair =
                                activeZoneIndex === zone && activePathStop?.rowKey === rowKey;
                              const isDonePair = visitedRows.has(rowKey);
                              const bayStateClass = isActivePair
                                ? "active"
                                : isDonePair
                                  ? "done"
                                  : "";

                              return [
                                renderBay(leftBay, `${rowKey}-left`, bayStateClass, {
                                  gridColumn: 1,
                                  gridRow: rowIndex + 1,
                                }),
                                renderBay(rightBay, `${rowKey}-right`, bayStateClass, {
                                  gridColumn: 3,
                                  gridRow: rowIndex + 1,
                                }),
                              ];
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function RackBay({
  bay,
  active,
  config,
  indexByName,
  activeIndex,
  sideLabel,
}: {
  bay: number | null;
  active: LocationRecord | undefined;
  config: LayoutConfig;
  indexByName: Map<string, number>;
  activeIndex: number;
  sideLabel: RouteSide;
}) {
  const shelves = Array.from({ length: config.shelves }, (_, index) => config.shelves - index);
  const slots = Array.from({ length: config.slots }, (_, index) => config.slots - index);

  return (
    <div className={`rack-bay side-${sideLabel} ${bay === active?.bay ? "active-bay" : ""}`}>
      <div className="rack-title">
        <span>{bay ? `Bay ${pad2(bay)}` : "No bay"}</span>
        <strong>{sideLabel}</strong>
      </div>
      <div
        className="shelf-stack"
        style={{ gridTemplateColumns: `repeat(${config.shelves}, minmax(16px, 20px))` }}
      >
        {shelves.map((shelf) => (
          <div className="shelf-row" key={`${bay}-${shelf}`}>
            <span className="shelf-label">{lettersFromNumber(shelf)}</span>
            <div
              className="slot-grid"
              style={{ gridTemplateRows: `repeat(${config.slots}, minmax(10px, 18px))` }}
            >
              {slots.map((slot) => {
                const name =
                  active && bay
                    ? locationName(active.zoneIndex, active.aisle, bay, shelf, slot)
                    : "";
                const coordinate =
                  active && bay
                    ? pickCoordinateKey(active.zoneIndex, active.aisle, bay, shelf, slot)
                    : "";
                const stepIndex = indexByName.get(coordinate);
                const isActive = active
                  ? coordinate ===
                    pickCoordinateKey(
                      active.zoneIndex,
                      active.aisle,
                      active.bay,
                      active.shelfIndex,
                      active.slot,
                    )
                  : false;
                const isDone = typeof stepIndex === "number" && stepIndex < activeIndex;
                const isPlanned = typeof stepIndex === "number";

                return (
                  <div
                    className={`slot ${isPlanned ? "planned" : "unplanned"} ${
                      isActive ? "active" : ""
                    } ${isDone ? "done" : ""}`}
                    key={`${bay}-${shelf}-${slot}`}
                    title={name}
                  >
                    <span className="slot-number">{pad2(slot)}</span>
                    {isActive && <span aria-hidden="true" className="slot-pick-item" />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AislePickView({
  locations,
  activeIndex,
  active,
  controls,
  config,
  speedMs,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  active: LocationRecord | undefined;
  controls: ReactNode;
  config: LayoutConfig;
  speedMs: number;
}) {
  const indexByName = useMemo(() => {
    const map = new Map<string, number>();
    locations.forEach((location, index) =>
      map.set(
        pickCoordinateKey(
          location.zoneIndex,
          location.aisle,
          location.bay,
          location.shelfIndex,
          location.slot,
        ),
        index,
      ),
    );
    return map;
  }, [locations]);

  const activeRouteSide = active && active.bay % 2 === 0 ? "right" : "left";
  const activeVertical = active && active.bay > 2 ? "top" : "bottom";
  const aisleLabel = active ? `${active.zoneLabel}${active.aisleLabel}` : "01A";
  const simulationStyle = {
    "--glide-ms": `${speedMs}ms`,
  } as CSSProperties;

  return (
    <section className="panel visualization-panel aisle-visualization" style={simulationStyle}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Aisle simulation</p>
          <h2>{aisleLabel}</h2>
        </div>
        <span className="small-badge">
          {active?.name ?? "No active pick"}
        </span>
      </div>
      {controls}

      <div className="aisle-demo-layout">
        <div className="aisle-demo-rack bay-03">
          <RackBay
            active={active}
            activeIndex={activeIndex}
            bay={3}
            config={config}
            indexByName={indexByName}
            sideLabel="left"
          />
        </div>

        <div className={`aisle-demo-lane ${activeRouteSide} ${activeVertical}`}>
          <div className="aisle-demo-label">
            <strong>{aisleLabel}</strong>
          </div>
          <div className={`picker-reach ${activeRouteSide}`} />
          <div className="picker-marker">
            <span>Picker</span>
          </div>
          <div className="lane-line" />
        </div>

        <div className="aisle-demo-rack bay-04">
          <RackBay
            active={active}
            activeIndex={activeIndex}
            bay={4}
            config={config}
            indexByName={indexByName}
            sideLabel="right"
          />
        </div>

        <div className="aisle-demo-rack bay-01">
          <RackBay
            active={active}
            activeIndex={activeIndex}
            bay={1}
            config={config}
            indexByName={indexByName}
            sideLabel="left"
          />
        </div>

        <div className="aisle-demo-rack bay-02">
          <RackBay
            active={active}
            activeIndex={activeIndex}
            bay={2}
            config={config}
            indexByName={indexByName}
            sideLabel="right"
          />
        </div>
      </div>
    </section>
  );
}

function RouteTimeline({
  locations,
  activeIndex,
  onSelect,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const start = Math.max(0, activeIndex - 8);
  const visible = locations.slice(start, activeIndex + 18);

  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Pick sequence</p>
          <h2>{locations.length.toLocaleString()} highlighted picks</h2>
        </div>
      </div>
      <div className="timeline-list">
        {visible.map((location, index) => {
          const routeIndex = start + index;
          return (
            <button
              className={`route-step ${routeIndex === activeIndex ? "active" : ""} ${
                routeIndex < activeIndex ? "done" : ""
              }`}
              key={`${location.name}-${routeIndex}`}
              onClick={() => onSelect(routeIndex)}
              type="button"
            >
              <strong>{location.name}</strong>
              <em>{location.side}</em>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function OutputPage({
  analysis,
  activeLocations,
  generatedLocations,
  canUseUploaded,
  mode,
  onDownload,
  onUpload,
  onSourceChange,
}: {
  analysis: UploadAnalysis | null;
  activeLocations: LocationRecord[];
  generatedLocations: LocationRecord[];
  canUseUploaded: boolean;
  mode: SourceMode;
  onDownload: () => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSourceChange: (mode: SourceMode) => void;
}) {
  return (
    <div className="page-grid output-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ShipHero CSV</p>
            <h2>Export</h2>
          </div>
          <span className="small-badge">{activeLocations.length.toLocaleString()} rows</span>
        </div>
        <SourceSwitch
          canUseUploaded={canUseUploaded}
          mode={mode}
          onChange={onSourceChange}
        />
        <button className="primary-action" onClick={onDownload} type="button">
          Download ShipHero CSV
        </button>
        <div className="csv-preview">
          <div className="csv-row header">
            <span>Name</span>
            <span>Pickable</span>
            <span>Priority</span>
            <span>Type</span>
            <span>Sellable</span>
          </div>
          {activeLocations.slice(0, 10).map((location) => (
            <div className="csv-row" key={location.name}>
              <span>{location.name}</span>
              <span>Yes</span>
              <span>0</span>
              <span>Bin</span>
              <span>Yes</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Customer CSV</p>
            <h2>Import check</h2>
          </div>
        </div>
        <label className="file-drop">
          <input accept=".csv,text/csv" onChange={onUpload} type="file" />
          <span>Choose CSV</span>
          <strong>{analysis?.fileName ?? "No file selected"}</strong>
        </label>
        <div className="health-grid">
          <HealthPill
            count={analysis?.validLocations.length ?? 0}
            label="valid"
            tone="good"
          />
          <HealthPill
            count={analysis?.invalidNames.length ?? 0}
            label="invalid"
            tone={(analysis?.invalidNames.length ?? 0) > 0 ? "bad" : "good"}
          />
          <HealthPill
            count={analysis?.duplicateNames.length ?? 0}
            label="duplicates"
            tone={(analysis?.duplicateNames.length ?? 0) > 0 ? "bad" : "good"}
          />
          <HealthPill
            count={analysis?.routeBacktracks.length ?? 0}
            label="backtracks"
            tone={(analysis?.routeBacktracks.length ?? 0) > 0 ? "warn" : "good"}
          />
          <HealthPill
            count={analysis?.legacyPrefixNames.length ?? 0}
            label="legacy prefix"
            tone={(analysis?.legacyPrefixNames.length ?? 0) > 0 ? "warn" : "good"}
          />
        </div>
        <div className={`issue-list ${analysis ? "" : "muted"}`}>
          {analysis ? (
            <>
              {analysis.legacyPrefixNames.slice(0, 4).map((name) => (
                <p key={`legacy-${name}`}>Legacy prefix order: {name}</p>
              ))}
              {analysis.nonPaddedNames.slice(0, 4).map((name) => (
                <p key={`pad-${name}`}>Needs padding: {name}</p>
              ))}
              {analysis.invalidNames.slice(0, 4).map((name) => (
                <p key={`invalid-${name}`}>Invalid format: {name}</p>
              ))}
              {analysis.duplicateNames.slice(0, 4).map((name) => (
                <p key={`duplicate-${name}`}>Duplicate: {name}</p>
              ))}
              {analysis.routeBacktracks.slice(0, 4).map((jump) => (
                <p key={`jump-${jump}`}>Route jump: {jump}</p>
              ))}
              {analysis.nonPaddedNames.length === 0 &&
                analysis.invalidNames.length === 0 &&
                analysis.duplicateNames.length === 0 &&
                analysis.legacyPrefixNames.length === 0 &&
                analysis.routeBacktracks.length === 0 && (
                  <p>No obvious sort or format issues in the imported names.</p>
                )}
            </>
          ) : (
            <p>Reads a ShipHero-style CSV and simulates the Name column route.</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Generated reference</p>
            <h2>Current layout</h2>
          </div>
        </div>
        <div className="summary-band stacked">
          <Stat
            label="Generated bin locations"
            value={generatedLocations.length.toLocaleString()}
          />
          <Stat label="First location" value={generatedLocations[0]?.name ?? "-"} />
          <Stat
            label="Last location"
            value={generatedLocations[generatedLocations.length - 1]?.name ?? "-"}
          />
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const [activePage, setActivePage] = useState<PageKey>("create");
  const [config, setConfig] = useState<LayoutConfig>(defaultConfig);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [activeIndex, setActiveIndex] = useState(0);
  const [speedMs, setSpeedMs] = useState(600);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysis, setAnalysis] = useState<UploadAnalysis | null>(null);
  const [mode, setMode] = useState<SourceMode>("generated");
  const [routePattern, setRoutePattern] = useState<RoutePattern>("serpentine");
  const [randomPickCount, setRandomPickCount] = useState(8);
  const [randomPickSeed, setRandomPickSeed] = useState(1);
  const [overheadZoom, setOverheadZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState<ViewportSize>({
    width: 1280,
    height: 900,
  });

  const generatedLocations = useMemo(() => generateLocations(config), [config]);
  const uploadedLocations = analysis?.validLocations ?? [];
  const activeLocations =
    mode === "uploaded" && uploadedLocations.length > 0
      ? uploadedLocations
      : generatedLocations;
  const activeConfig =
    mode === "uploaded" && uploadedLocations.length > 0
      ? analysis?.inferredConfig ?? config
      : config;
  const aisleSourceLocations = useMemo(
    () =>
      activeLocations.filter(
        (location) =>
          location.zoneIndex === 1 &&
          location.aisle === 1 &&
          location.bay >= 1 &&
          location.bay <= 4,
      ),
    [activeLocations],
  );
  const effectiveRandomPickCount = clampNumber(
    randomPickCount,
    1,
    Math.max(1, aisleSourceLocations.length),
  );
  const overheadPath = useMemo(
    () => buildOverheadPath(activeConfig, routePattern),
    [activeConfig, routePattern],
  );
  const aislePickStops = useMemo(
    () =>
      buildRandomPickStops(
        aisleSourceLocations,
        effectiveRandomPickCount,
        randomPickSeed,
      ),
    [aisleSourceLocations, effectiveRandomPickCount, randomPickSeed],
  );
  const isSimulatorPage = activePage === "overhead" || activePage === "aisle";
  const simulationTotal =
    activePage === "overhead" ? overheadPath.length : aislePickStops.length;
  const safeActiveIndex = Math.min(
    activeIndex,
    Math.max(0, simulationTotal - 1),
  );
  const activePathStop = overheadPath[safeActiveIndex];
  const activePick = aislePickStops[safeActiveIndex];
  const activeLabel =
    activePage === "overhead"
      ? activePathStop
        ? `Walking ${activePathStop.zoneLabel}${activePathStop.aisleLabel}`
        : "Walking route"
      : activePick?.name ?? "No active pick";
  const csv = useMemo(() => buildShipHeroCsv(activeLocations), [activeLocations]);
  const canUseUploaded = uploadedLocations.length > 0;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const updateViewportSize = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);

    return () => window.removeEventListener("resize", updateViewportSize);
  }, []);

  useEffect(() => {
    if (!isPlaying || !isSimulatorPage || simulationTotal === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveIndex((current) => {
        if (current >= simulationTotal - 1) {
          window.clearInterval(timer);
          setIsPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, speedMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, isSimulatorPage, simulationTotal, speedMs]);

  const updateConfig = (key: keyof LayoutConfig, value: number) => {
    setActiveIndex(0);
    setIsPlaying(false);
    setConfig((current) => ({
      ...current,
      [key]: clampNumber(value, 1, inputLimits[key]),
    }));
  };

  const selectMode = (nextMode: SourceMode) => {
    setMode(nextMode);
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const selectRoutePattern = (nextPattern: RoutePattern) => {
    setRoutePattern(nextPattern);
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const updateRandomPickCount = (value: number) => {
    setRandomPickCount(
      clampNumber(value, 1, Math.max(1, aisleSourceLocations.length)),
    );
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const randomizePickStops = () => {
    setRandomPickSeed((seed) => seed + 1);
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const resetSimulation = () => {
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const handleDownload = () => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "shiphero_locations.csv";
    link.click();
    window.URL.revokeObjectURL(url);
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    const uploadAnalysis = analyzeImportedCsv(text, file.name);
    setAnalysis(uploadAnalysis);
    setMode("uploaded");
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const playbackControls = (
    <PlaybackControls
      activeLabel={activeLabel}
      activeIndex={safeActiveIndex}
      isPlaying={isPlaying}
      onPlayPause={() => setIsPlaying((playing) => !playing)}
      onReset={resetSimulation}
      onSeek={setActiveIndex}
      onSpeedChange={setSpeedMs}
      speedMs={speedMs}
      total={simulationTotal}
    />
  );
  const simulationControls = ({
    showRandomPickControls,
    showRoutePattern,
    showZoomControls,
  }: {
    showRandomPickControls: boolean;
    showRoutePattern: boolean;
    showZoomControls: boolean;
  }) => (
    <div className="simulation-controls">
      {showRoutePattern && (
        <RoutePatternSwitch
          onChange={selectRoutePattern}
          routePattern={routePattern}
        />
      )}
      {showZoomControls && (
        <ViewZoomControls
          onZoomChange={setOverheadZoom}
          zoom={overheadZoom}
        />
      )}
      {showRandomPickControls && (
        <RandomPickControls
          maxCount={aisleSourceLocations.length}
          onPickCountChange={updateRandomPickCount}
          onRandomize={randomizePickStops}
          pickCount={effectiveRandomPickCount}
        />
      )}
      {playbackControls}
    </div>
  );

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">ShipHero bin planning</p>
          <h1>Bin route simulator</h1>
        </div>
        <div className="top-actions">
          <PageTabs
            activePage={activePage}
            onChange={(page) => {
              setActivePage(page);
              setIsPlaying(false);
              setActiveIndex(0);
            }}
          />
          <ThemeToggle onChange={setTheme} theme={theme} />
        </div>
      </header>

      {activePage === "create" && (
        <CreatePage
          canUseUploaded={canUseUploaded}
          config={config}
          generatedLocations={generatedLocations}
          mode={mode}
          onConfigChange={updateConfig}
          onSourceChange={selectMode}
        />
      )}

      {activePage === "overhead" && (
        <div className="simulation-grid">
          <div className="simulation-main">
            <OverheadRoute
              activeIndex={safeActiveIndex}
              controls={simulationControls({
                showRandomPickControls: false,
                showRoutePattern: true,
                showZoomControls: true,
              })}
              config={activeConfig}
              pathStops={overheadPath}
              routePattern={routePattern}
              speedMs={speedMs}
              viewportSize={viewportSize}
              zoom={overheadZoom}
            />
          </div>
        </div>
      )}

      {activePage === "aisle" && (
        <div className="simulation-grid">
          <div className="simulation-main">
            <AislePickView
              active={activePick}
              activeIndex={safeActiveIndex}
              controls={simulationControls({
                showRandomPickControls: true,
                showRoutePattern: false,
                showZoomControls: false,
              })}
              config={activeConfig}
              locations={aislePickStops}
              speedMs={speedMs}
            />
            <RouteTimeline
              activeIndex={safeActiveIndex}
              locations={aislePickStops}
              onSelect={setActiveIndex}
            />
          </div>
        </div>
      )}

      {activePage === "output" && (
        <OutputPage
          activeLocations={activeLocations}
          analysis={analysis}
          canUseUploaded={canUseUploaded}
          generatedLocations={generatedLocations}
          mode={mode}
          onDownload={handleDownload}
          onSourceChange={selectMode}
          onUpload={handleUpload}
        />
      )}
    </main>
  );
}
