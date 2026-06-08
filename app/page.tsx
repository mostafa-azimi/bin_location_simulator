"use client";

import {
  ChangeEvent,
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type RouteSide = "left" | "right";
type PageKey = "create" | "overhead" | "aisle" | "output";
type SourceMode = "generated" | "uploaded";
type RoutePattern = "serpentine" | "u-shape";
type TrackDirection = "up" | "down" | "u-path" | "turn-top" | "turn-bottom";
type ThemeMode = "dark" | "light";
type ViewportSize = {
  width: number;
  height: number;
};
type BaySelection = {
  zoneIndex: number;
  aisle: number;
  bay: number;
};
type PanPoint = {
  x: number;
  y: number;
};
type PanZoomDrag = {
  panX: number;
  panY: number;
  pointerId: number;
  startX: number;
  startY: number;
};

type LayoutConfig = {
  zones: number;
  aisles: number;
  bays: number;
  shelves: number;
  slots: number;
};
type LayoutDraftConfig = Record<keyof LayoutConfig, string>;

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
  kind: "row" | "turn";
  activeBays: number[];
  zoneIndex: number;
  zoneLabel: string;
  aisle: number;
  aisleLabel: string;
  rowKey: string;
  trackDirection: TrackDirection;
  nextAisle?: number;
  nextAisleLabel?: string;
  turnSide?: "top" | "bottom";
};

const defaultConfig: LayoutConfig = {
  zones: 1,
  aisles: 3,
  bays: 4,
  shelves: 3,
  slots: 4,
};
const layoutConfigKeys = Object.keys(defaultConfig) as Array<keyof LayoutConfig>;

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
  { key: "aisle", label: "Simulator" },
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

const clampValue = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

const configToDraft = (config: LayoutConfig): LayoutDraftConfig =>
  layoutConfigKeys.reduce(
    (draft, key) => ({
      ...draft,
      [key]: String(config[key]),
    }),
    {} as LayoutDraftConfig,
  );

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

function baySelectionLabel(selection: BaySelection) {
  return `${pad2(selection.zoneIndex)}${lettersFromNumber(selection.aisle)} Bay ${pad2(
    selection.bay,
  )}`;
}

function baySelectionName(selection: BaySelection) {
  return `${pad2(selection.zoneIndex)}${lettersFromNumber(selection.aisle)}-${pad2(
    selection.bay,
  )}`;
}

function isSameBaySelection(left: BaySelection, right: BaySelection) {
  return (
    left.zoneIndex === right.zoneIndex &&
    left.aisle === right.aisle &&
    left.bay === right.bay
  );
}

function usePanZoom({
  baseScale,
  maxZoom,
  minZoom,
  onPanChange,
  onZoomChange,
  pan,
  zoom,
}: {
  baseScale: number;
  maxZoom: number;
  minZoom: number;
  onPanChange: (pan: PanPoint) => void;
  onZoomChange: (zoom: number) => void;
  pan: PanPoint;
  zoom: number;
}) {
  const dragRef = useRef<PanZoomDrag | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const currentScale = Math.max(0.001, baseScale * zoom);

  const zoomAroundPoint = (
    viewport: HTMLElement,
    clientX: number,
    clientY: number,
    nextZoom: number,
  ) => {
    const rect = viewport.getBoundingClientRect();
    const pointX = clientX - rect.left - rect.width / 2;
    const pointY = clientY - rect.top;
    const clampedZoom = clampValue(nextZoom, minZoom, maxZoom);
    const nextScale = Math.max(0.001, baseScale * clampedZoom);
    const ratio = nextScale / currentScale;

    onPanChange({
      x: pointX - (pointX - pan.x) * ratio,
      y: pointY - (pointY - pan.y) * ratio,
    });
    onZoomChange(clampedZoom);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();

    if (event.deltaY === 0) {
      return;
    }

    const factor = event.deltaY < 0 ? 1.12 : 0.88;
    zoomAroundPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
      zoom * factor,
    );
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) {
      return;
    }

    zoomAroundPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
      zoom * 1.45,
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    if (
      event.target instanceof HTMLElement &&
      event.target.closest("button,input,label")
    ) {
      return;
    }

    dragRef.current = {
      panX: pan.x,
      panY: pan.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    onPanChange({
      x: drag.panX + event.clientX - drag.startX,
      y: drag.panY + event.clientY - drag.startY,
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    setIsDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return {
    handlers: {
      onDoubleClick: handleDoubleClick,
      onPointerCancel: endDrag,
      onPointerDown: handlePointerDown,
      onPointerLeave: endDrag,
      onPointerMove: handlePointerMove,
      onPointerUp: endDrag,
      onWheel: handleWheel,
    },
    isDragging,
  };
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

function overheadTurnKey(zoneIndex: number, aisle: number, turnSide: "top" | "bottom") {
  return `${zoneIndex}-${aisle}-${aisle + 1}-${turnSide}-turn`;
}

function overheadBayKey(zoneIndex: number, aisle: number, bay: number) {
  return `${zoneIndex}-${aisle}-${bay}`;
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
        activeBays = [row.leftBay, row.rightBay].filter(
          (bay): bay is number => typeof bay === "number",
        ),
      ) => {
        path.push({
          kind: "row",
          activeBays,
          zoneIndex: zone,
          zoneLabel: pad2(zone),
          aisle,
          aisleLabel,
          rowKey: overheadRowKey(zone, aisle, row.leftBay, row.rightBay),
          trackDirection,
        });
      };
      const addTurn = (turnSide: "top" | "bottom") => {
        if (aisle >= config.aisles) {
          return;
        }

        const nextAisleLabel = lettersFromNumber(aisle + 1);
        path.push({
          kind: "turn",
          activeBays: [],
          zoneIndex: zone,
          zoneLabel: pad2(zone),
          aisle,
          aisleLabel,
          nextAisle: aisle + 1,
          nextAisleLabel,
          rowKey: overheadTurnKey(zone, aisle, turnSide),
          trackDirection: turnSide === "top" ? "turn-top" : "turn-bottom",
          turnSide,
        });
      };

      if (routePattern === "u-shape") {
        [...rows].reverse().forEach((row) =>
          addStop(
            row,
            "up",
            row.leftBay ? [row.leftBay] : [],
          ),
        );
        rows.forEach((row) =>
          addStop(
            row,
            "down",
            row.rightBay ? [row.rightBay] : [],
          ),
        );
        addTurn("bottom");
        continue;
      }

      const traversalRows = aisleDirection === "up" ? [...rows].reverse() : rows;
      traversalRows.forEach((row) => addStop(row, aisleDirection));
      addTurn(aisleDirection === "up" ? "top" : "bottom");
    }
  }

  return path;
}

function getBayRouteContext(
  config: LayoutConfig,
  routePattern: RoutePattern,
  selection: BaySelection,
): {
  facingSide: RouteSide;
  physicalSide: RouteSide;
  travelDirection: "up" | "down";
} {
  const direction =
    routePattern === "serpentine" && selection.aisle % 2 === 0 ? "down" : "up";
  const rows = buildOverheadRows(config, routePattern, direction);
  const row = rows.find(
    ({ leftBay, rightBay }) => leftBay === selection.bay || rightBay === selection.bay,
  );
  const physicalSide = row?.rightBay === selection.bay ? "right" : "left";
  const travelDirection =
    routePattern === "u-shape"
      ? physicalSide === "left"
        ? "up"
        : "down"
      : direction;

  return {
    facingSide:
      travelDirection === "down"
        ? physicalSide === "left"
          ? "right"
          : "left"
        : physicalSide,
    physicalSide,
    travelDirection,
  };
}

function buildBayPickStops(
  locations: LocationRecord[],
  selection: BaySelection,
) {
  return locations
    .filter(
      (location) =>
        location.zoneIndex === selection.zoneIndex &&
        location.aisle === selection.aisle &&
        location.bay === selection.bay,
    )
    .sort(
      (a, b) =>
        a.shelfIndex - b.shelfIndex ||
        a.slot - b.slot ||
        alphaSort(a.name, b.name),
    );
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

function ViewZoomControls({
  zoom,
  onZoomChange,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}) {
  return (
    <div className="toolbar-group zoom-panel">
      <span className="control-label">View zoom</span>
      <div className="zoom-button-row">
        <button className="ghost-action compact-action" onClick={onZoomOut} type="button">
          -
        </button>
        <button className="ghost-action compact-action" onClick={onZoomReset} type="button">
          Reset
        </button>
        <button className="ghost-action compact-action" onClick={onZoomIn} type="button">
          +
        </button>
      </div>
      <label className="range-field speed-field">
        <span>Zoom</span>
        <input
          max={4}
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
  showActiveLabel = true,
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
  showActiveLabel?: boolean;
  total: number;
  isPlaying: boolean;
  speedMs: number;
  onPlayPause: () => void;
  onReset: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speedMs: number) => void;
}) {
  return (
    <div className={`toolbar-group playback-panel ${showActiveLabel ? "" : "no-active-label"}`}>
      <div className="compact-heading">
        {showActiveLabel && <span className="control-label">{activeLabel}</span>}
        <span className="small-badge">{total ? `${activeIndex + 1} / ${total}` : "0 / 0"}</span>
      </div>

      <div className="playback-row">
        <button
          className="primary-action compact"
          disabled={total === 0}
          onClick={onPlayPause}
          type="button"
        >
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
  configDraft,
  generatedLocations,
  mode,
  canUseUploaded,
  onConfigBlur,
  onConfigDraftChange,
  onSourceChange,
}: {
  configDraft: LayoutDraftConfig;
  generatedLocations: LocationRecord[];
  mode: SourceMode;
  canUseUploaded: boolean;
  onConfigBlur: (key: keyof LayoutConfig) => void;
  onConfigDraftChange: (key: keyof LayoutConfig, value: string) => void;
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
          {layoutConfigKeys.map((key) => (
            <label className="number-field" key={key}>
              <span>{labels[key]}</span>
              <input
                max={inputLimits[key]}
                min={1}
                onChange={(event) =>
                  onConfigDraftChange(key, event.target.value)
                }
                onBlur={() => onConfigBlur(key)}
                type="number"
                value={configDraft[key]}
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

function RouteTurnConnector({
  active,
  compact = false,
  done = false,
  side,
}: {
  active: boolean;
  compact?: boolean;
  done?: boolean;
  side: "top" | "bottom";
}) {
  return (
    <div
      aria-hidden="true"
      className={`route-turn-connector ${compact ? "compact" : ""} ${side} ${
        active ? "active" : ""
      } ${done ? "done" : ""}`}
    >
      <svg preserveAspectRatio="none" viewBox="0 0 116 52">
        <path
          d={
            side === "top"
              ? "M 0 50 C 0 8 116 8 116 50"
              : "M 0 2 C 0 44 116 44 116 2"
          }
        />
      </svg>
      {active && (
        <div className="turn-picker">
          <span>Picker</span>
        </div>
      )}
    </div>
  );
}

function OverheadRoute({
  activeIndex,
  controls,
  config,
  onPanChange,
  onZoomChange,
  pan,
  speedMs,
  zoom,
  routePattern,
  pathStops,
  viewportSize,
}: {
  activeIndex: number;
  controls: ReactNode;
  config: LayoutConfig;
  onPanChange: (pan: PanPoint) => void;
  onZoomChange: (zoom: number) => void;
  pan: PanPoint;
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
  const visitedBays = useMemo(() => {
    const bays = new Set<string>();
    pathStops.slice(0, activeIndex).forEach((stop) => {
      stop.activeBays.forEach((bay) => {
        bays.add(overheadBayKey(stop.zoneIndex, stop.aisle, bay));
      });
    });
    return bays;
  }, [activeIndex, pathStops]);
  const zones = Array.from({ length: config.zones }, (_, index) => index + 1);
  const aisles = Array.from({ length: config.aisles }, (_, index) => index + 1);
  const totalBays = totalBayCount(config);
  const naturalAisleWidth = 128;
  const naturalBayRowHeight = 78;
  const naturalWidth = Math.max(1, config.aisles) * naturalAisleWidth;
  const naturalZoneHeight =
    config.bays * naturalBayRowHeight +
    (config.aisles > 1 ? 92 : 0) +
    (config.zones > 1 ? 36 : 0);
  const naturalHeight =
    Math.max(1, config.zones) * naturalZoneHeight + Math.max(0, config.zones - 1) * 12;
  const availableWidth = Math.max(320, Math.min(1640, viewportSize.width - 68));
  const availableHeight = Math.max(240, viewportSize.height - 370);
  const fitScale = Math.min(
    1,
    availableWidth / naturalWidth,
    availableHeight / naturalHeight,
  );
  const layoutScale = Number((fitScale * zoom).toFixed(4));
  const panZoom = usePanZoom({
    baseScale: fitScale,
    maxZoom: 4,
    minZoom: 1,
    onPanChange,
    onZoomChange,
    pan,
    zoom,
  });
  const simulationStyle = {
    "--glide-ms": `${speedMs}ms`,
    "--layout-scale": layoutScale,
    "--zoom-pan-x": `${pan.x}px`,
    "--zoom-pan-y": `${pan.y}px`,
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

      <div
        className={`warehouse-scroll interactive-zoom-viewport ${
          panZoom.isDragging ? "dragging" : ""
        }`}
        {...panZoom.handlers}
      >
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
                      const bayKeys = rows.flatMap(({ leftBay, rightBay }) =>
                        [leftBay, rightBay]
                          .filter((bay): bay is number => typeof bay === "number")
                          .map((bay) => overheadBayKey(zone, aisle, bay)),
                      );
                      const connectorSide =
                        routePattern === "u-shape"
                          ? "bottom"
                          : direction === "up"
                            ? "top"
                            : "bottom";
                      const connectorKey = overheadTurnKey(zone, aisle, connectorSide);
                      const isActiveTurn =
                        activePathStop?.kind === "turn" &&
                        activePathStop.zoneIndex === zone &&
                        activePathStop.aisle === aisle &&
                        activePathStop.turnSide === connectorSide;
                      const isDoneTurn = visitedRows.has(connectorKey);
                      const activeRowIndex = rows.findIndex(
                        ({ leftBay, rightBay }) =>
                          activePathStop?.kind === "row" &&
                          activePathStop.rowKey ===
                          overheadRowKey(zone, aisle, leftBay, rightBay),
                      );
                      const isActiveAisle =
                        activePathStop?.kind === "row" &&
                        activeZoneIndex === zone &&
                        activePathStop.aisle === aisle;
                      const activeTrackDirection =
                        isActiveAisle && activePathStop
                          ? activePathStop.trackDirection
                          : routePattern === "u-shape"
                            ? "u-path"
                            : direction;
                      const completedAisle =
                        routePattern === "u-shape"
                          ? bayKeys.length > 0 &&
                            bayKeys.every((bayKey) => visitedBays.has(bayKey))
                          : rowKeys.length > 0 &&
                            rowKeys.every((rowKey) => visitedRows.has(rowKey));
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
                              const bayStateClass = (bay: number | null) => {
                                if (!bay) {
                                  return "";
                                }

                                const isActiveBay =
                                  activePathStop?.kind === "row" &&
                                  activeZoneIndex === zone &&
                                  activePathStop.aisle === aisle &&
                                  activePathStop.activeBays.includes(bay);
                                const isDoneBay =
                                  routePattern === "u-shape"
                                    ? visitedBays.has(overheadBayKey(zone, aisle, bay))
                                    : visitedRows.has(rowKey);

                                if (isActiveBay) {
                                  return "active";
                                }

                                if (isDoneBay) {
                                  return "done";
                                }

                                return "";
                              };

                              return [
                                renderBay(leftBay, `${rowKey}-left`, bayStateClass(leftBay), {
                                  gridColumn: 1,
                                  gridRow: rowIndex + 1,
                                }),
                                renderBay(rightBay, `${rowKey}-right`, bayStateClass(rightBay), {
                                  gridColumn: 3,
                                  gridRow: rowIndex + 1,
                                }),
                              ];
                            })}
                            {aisle < config.aisles && (
                              <RouteTurnConnector
                                active={isActiveTurn}
                                done={isDoneTurn}
                                side={connectorSide}
                              />
                            )}
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

function BaySelectorMap({
  config,
  onSelectBay,
  routePattern,
  selectedBay,
  viewportSize,
}: {
  config: LayoutConfig;
  onSelectBay: (selection: BaySelection) => void;
  routePattern: RoutePattern;
  selectedBay: BaySelection;
  viewportSize: ViewportSize;
}) {
  const zones = Array.from({ length: config.zones }, (_, index) => index + 1);
  const aisles = Array.from({ length: config.aisles }, (_, index) => index + 1);
  const [selectorZoom, setSelectorZoom] = useState(1);
  const [selectorPan, setSelectorPan] = useState<PanPoint>({ x: 0, y: 0 });
  const selectedRouteContext = getBayRouteContext(config, routePattern, selectedBay);
  const totalBays = totalBayCount(config);
  const naturalAisleWidth = 84;
  const naturalBayRowHeight = 52;
  const naturalWidth = Math.max(1, config.aisles) * naturalAisleWidth;
  const naturalZoneHeight =
    config.bays * naturalBayRowHeight +
    (config.aisles > 1 ? 62 : 0) +
    (config.zones > 1 ? 34 : 0);
  const naturalHeight =
    Math.max(1, config.zones) * naturalZoneHeight + Math.max(0, config.zones - 1) * 10;
  const availableWidth =
    viewportSize.width < 960
      ? Math.max(280, viewportSize.width - 76)
      : Math.max(340, Math.min(820, viewportSize.width * 0.52 - 54));
  const availableHeight = Math.max(300, viewportSize.height - 420);
  const selectorFitScale = clampValue(
    Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight),
    0.28,
    2.05,
  );
  const selectorScale = Number((selectorFitScale * selectorZoom).toFixed(4));
  const selectorPanZoom = usePanZoom({
    baseScale: selectorFitScale,
    maxZoom: 4,
    minZoom: 1,
    onPanChange: setSelectorPan,
    onZoomChange: setSelectorZoom,
    pan: selectorPan,
    zoom: selectorZoom,
  });
  const selectorStyle = {
    "--selector-pan-x": `${selectorPan.x}px`,
    "--selector-pan-y": `${selectorPan.y}px`,
    "--selector-scale": selectorScale,
    "--selector-height": `${availableHeight}px`,
  } as CSSProperties;

  const renderBay = (
    zoneIndex: number,
    aisle: number,
    bay: number | null,
    key: string,
    side: RouteSide,
    style: CSSProperties,
  ) => {
    if (!bay || bay > totalBays) {
      return <div className="selector-bay empty" key={key} style={style} />;
    }

    const selection = { zoneIndex, aisle, bay };
    const selected = isSameBaySelection(selection, selectedBay);

    return (
      <button
        aria-label={baySelectionLabel(selection)}
        aria-pressed={selected}
        className={`selector-bay ${side} ${selected ? "selected" : ""}`}
        data-bay-selector={baySelectionName(selection)}
        key={key}
        onClick={() => onSelectBay(selection)}
        style={style}
        type="button"
      >
        <span>{pad2(bay)}</span>
      </button>
    );
  };

  return (
    <div className="bay-selector-card">
      <div className="bay-card-heading">
        <span className="control-label">Overhead selector</span>
        <strong>{baySelectionName(selectedBay)}</strong>
      </div>
      <div
        className={`bay-selector-viewport interactive-zoom-viewport ${
          selectorPanZoom.isDragging ? "dragging" : ""
        }`}
        style={selectorStyle}
        {...selectorPanZoom.handlers}
      >
        <div className="bay-selector-zoom-surface">
          <div className="bay-selector-outline">
            {zones.map((zone) => {
              const zoneLabel = pad2(zone);

              return (
                <div className="selector-zone" key={zone}>
                  {config.zones > 1 && <div className="zone-label">Zone {zoneLabel}</div>}
                  <div
                    className="selector-route-grid"
                    style={{ gridTemplateColumns: `repeat(${config.aisles}, max-content)` }}
                  >
                    {aisles.map((aisle) => {
                      const direction =
                        routePattern === "serpentine" && aisle % 2 === 0 ? "down" : "up";
                      const rows = buildOverheadRows(config, routePattern, direction);
                      const aislePrefix = `${zoneLabel}${lettersFromNumber(aisle)}`;
                      const selectedRowIndex =
                        selectedBay.zoneIndex === zone && selectedBay.aisle === aisle
                          ? rows.findIndex(
                              ({ leftBay, rightBay }) =>
                                leftBay === selectedBay.bay ||
                                rightBay === selectedBay.bay,
                            )
                          : -1;
                      const selectorPickerTop =
                        selectedRowIndex >= 0
                          ? `${((selectedRowIndex + 0.5) / rows.length) * 100}%`
                          : undefined;
                      const connectorSide =
                        routePattern === "u-shape"
                          ? "bottom"
                          : direction === "up"
                            ? "top"
                            : "bottom";

                      return (
                        <div className="selector-aisle" key={`${zone}-${aisle}`}>
                          <div
                            className="selector-bay-stack"
                            style={
                              {
                                gridTemplateRows: `repeat(${rows.length}, minmax(46px, 1fr))`,
                              } as CSSProperties
                            }
                          >
                            <div
                              className="selector-aisle-track"
                              style={{ gridRow: `1 / span ${rows.length}` }}
                            >
                              <strong>{aislePrefix}</strong>
                              {selectedRowIndex >= 0 && (
                                <div
                                  className={`selector-picker-position physical-${selectedRouteContext.physicalSide}`}
                                  style={
                                    {
                                      "--selector-picker-top": selectorPickerTop,
                                    } as CSSProperties
                                  }
                                >
                                  <span>Picker</span>
                                </div>
                              )}
                            </div>
                            {rows.flatMap(({ leftBay, rightBay }, rowIndex) => [
                              renderBay(zone, aisle, leftBay, `${zone}-${aisle}-${rowIndex}-left`, "left", {
                                gridColumn: 1,
                                gridRow: rowIndex + 1,
                              }),
                              renderBay(zone, aisle, rightBay, `${zone}-${aisle}-${rowIndex}-right`, "right", {
                                gridColumn: 3,
                                gridRow: rowIndex + 1,
                              }),
                            ])}
                            {aisle < config.aisles && (
                              <RouteTurnConnector
                                active={false}
                                compact
                                side={connectorSide}
                              />
                            )}
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
    </div>
  );
}

function BayFaceView({
  active,
  activeIndex,
  config,
  locations,
  selectedBay,
  side,
}: {
  active: LocationRecord | undefined;
  activeIndex: number;
  config: LayoutConfig;
  locations: LocationRecord[];
  selectedBay: BaySelection;
  side: RouteSide;
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
  const shelves = Array.from(
    { length: config.shelves },
    (_, index) => config.shelves - index,
  );
  const slots = Array.from({ length: config.slots }, (_, index) => index + 1);
  const activeCoordinate = active
    ? pickCoordinateKey(
        active.zoneIndex,
        active.aisle,
        active.bay,
        active.shelfIndex,
        active.slot,
      )
    : "";

  const rack = (
    <div className={`bay-face-rack side-${side}`}>
      <div
        className="bay-face-grid"
        style={{
          gridTemplateRows: `repeat(${config.shelves}, minmax(0, 1fr))`,
        }}
      >
        {shelves.map((shelf) => (
          <div className="bay-face-shelf" key={`${selectedBay.bay}-${shelf}`}>
            <span className="bay-face-shelf-label">{lettersFromNumber(shelf)}</span>
            <div
              className="bay-face-slot-row"
              style={{ gridTemplateColumns: `repeat(${config.slots}, minmax(0, 1fr))` }}
            >
              {slots.map((slot) => {
                const name = locationName(
                  selectedBay.zoneIndex,
                  selectedBay.aisle,
                  selectedBay.bay,
                  shelf,
                  slot,
                );
                const coordinate = pickCoordinateKey(
                  selectedBay.zoneIndex,
                  selectedBay.aisle,
                  selectedBay.bay,
                  shelf,
                  slot,
                );
                const stepIndex = indexByName.get(coordinate);
                const isActive = coordinate === activeCoordinate;
                const isDone = typeof stepIndex === "number" && stepIndex < activeIndex;
                const isPlanned = typeof stepIndex === "number";

                return (
                  <div
                    className={`bay-face-slot ${isPlanned ? "planned" : "unplanned"} ${
                      isActive ? "active" : ""
                    } ${isDone ? "done" : ""}`}
                    key={coordinate}
                    title={name}
                  >
                    <span>{pad2(slot)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const picker = (
    <div className="bay-picker-stand">
      <div className="bay-picker-marker">
        <span>Picker</span>
      </div>
    </div>
  );

  return (
    <div
      className={`bay-face-card side-${side}`}
      style={
        {
          "--bay-shelves": config.shelves,
          "--bay-slots": config.slots,
        } as CSSProperties
      }
    >
      <div className="bay-card-heading">
        <span className="control-label">Picker view</span>
        <strong>{active?.name ?? baySelectionName(selectedBay)}</strong>
      </div>
      <div className={`bay-face-stage side-${side}`}>
        {rack}
        {picker}
      </div>
    </div>
  );
}

function AisleBayInspector({
  active,
  activeIndex,
  controls,
  config,
  locations,
  onSelectBay,
  routePattern,
  selectedBay,
  speedMs,
  viewportSize,
}: {
  active: LocationRecord | undefined;
  activeIndex: number;
  controls: ReactNode;
  config: LayoutConfig;
  locations: LocationRecord[];
  onSelectBay: (selection: BaySelection) => void;
  routePattern: RoutePattern;
  selectedBay: BaySelection;
  speedMs: number;
  viewportSize: ViewportSize;
}) {
  const routeContext = getBayRouteContext(config, routePattern, selectedBay);
  const side = routeContext.facingSide;
  const simulationStyle = {
    "--glide-ms": `${speedMs}ms`,
  } as CSSProperties;

  return (
    <section className="panel visualization-panel aisle-visualization" style={simulationStyle}>
      <div className="panel-heading">
        <div>
          <h2>Bay simulator</h2>
        </div>
      </div>
      {controls}
      <div className="aisle-inspector-grid">
        <BaySelectorMap
          config={config}
          onSelectBay={onSelectBay}
          routePattern={routePattern}
          selectedBay={selectedBay}
          viewportSize={viewportSize}
        />
        <BayFaceView
          active={active}
          activeIndex={activeIndex}
          config={config}
          locations={locations}
          selectedBay={selectedBay}
          side={side}
        />
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
  const [configDraft, setConfigDraft] = useState<LayoutDraftConfig>(() =>
    configToDraft(defaultConfig),
  );
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [activeIndex, setActiveIndex] = useState(0);
  const [speedMs, setSpeedMs] = useState(600);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysis, setAnalysis] = useState<UploadAnalysis | null>(null);
  const [mode, setMode] = useState<SourceMode>("generated");
  const [routePattern, setRoutePattern] = useState<RoutePattern>("serpentine");
  const [selectedBay, setSelectedBay] = useState<BaySelection>({
    zoneIndex: 1,
    aisle: 1,
    bay: 1,
  });
  const [overheadZoom, setOverheadZoom] = useState(1);
  const [overheadPan, setOverheadPan] = useState<PanPoint>({ x: 0, y: 0 });
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
  const normalizedSelectedBay = useMemo(
    () => ({
      zoneIndex: clampNumber(selectedBay.zoneIndex, 1, activeConfig.zones),
      aisle: clampNumber(selectedBay.aisle, 1, activeConfig.aisles),
      bay: clampNumber(selectedBay.bay, 1, totalBayCount(activeConfig)),
    }),
    [
      activeConfig,
      selectedBay.aisle,
      selectedBay.bay,
      selectedBay.zoneIndex,
    ],
  );
  const overheadPath = useMemo(
    () => buildOverheadPath(activeConfig, routePattern),
    [activeConfig, routePattern],
  );
  const selectedBayPickStops = useMemo(
    () => buildBayPickStops(activeLocations, normalizedSelectedBay),
    [activeLocations, normalizedSelectedBay],
  );
  const isSimulatorPage = activePage === "overhead" || activePage === "aisle";
  const simulationTotal =
    activePage === "overhead" ? overheadPath.length : selectedBayPickStops.length;
  const safeActiveIndex = Math.min(
    activeIndex,
    Math.max(0, simulationTotal - 1),
  );
  const activePathStop = overheadPath[safeActiveIndex];
  const activePick = selectedBayPickStops[safeActiveIndex];
  const activeLabel =
    activePage === "overhead"
      ? activePathStop
        ? activePathStop.kind === "turn"
          ? `Turning to ${activePathStop.zoneLabel}${activePathStop.nextAisleLabel ?? ""}`
          : routePattern === "u-shape" && activePathStop.activeBays[0]
            ? `Picking ${activePathStop.zoneLabel}${activePathStop.aisleLabel} Bay ${pad2(
                activePathStop.activeBays[0],
              )}`
            : `Walking ${activePathStop.zoneLabel}${activePathStop.aisleLabel}`
        : "Walking route"
      : activePick?.name ?? `${baySelectionName(normalizedSelectedBay)} sequence`;
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

  const updateConfigDraft = (key: keyof LayoutConfig, value: string) => {
    setConfigDraft((current) => ({
      ...current,
      [key]: value,
    }));

    if (value.trim() === "") {
      return;
    }

    const parsedValue = Number(value);

    if (Number.isFinite(parsedValue)) {
      updateConfig(key, parsedValue);
    }
  };

  const normalizeConfigDraft = (key: keyof LayoutConfig) => {
    const rawValue = configDraft[key];
    const parsedValue = rawValue.trim() === "" ? Number.NaN : Number(rawValue);
    const normalizedValue = Number.isFinite(parsedValue)
      ? clampNumber(parsedValue, 1, inputLimits[key])
      : config[key];

    setConfigDraft((current) => ({
      ...current,
      [key]: String(normalizedValue),
    }));
    updateConfig(key, normalizedValue);
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

  const selectBay = (selection: BaySelection) => {
    setSelectedBay(selection);
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const resetSimulation = () => {
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const updateOverheadZoom = (zoom: number) => {
    setOverheadZoom(clampValue(zoom, 1, 4));
  };

  const zoomOverheadIn = () => {
    updateOverheadZoom(overheadZoom * 1.2);
  };

  const zoomOverheadOut = () => {
    updateOverheadZoom(overheadZoom / 1.2);
  };

  const resetOverheadView = () => {
    setOverheadZoom(1);
    setOverheadPan({ x: 0, y: 0 });
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
      showActiveLabel={activePage === "overhead"}
      speedMs={speedMs}
      total={simulationTotal}
    />
  );
  const simulationControls = ({
    showRoutePattern,
    showZoomControls,
  }: {
    showRoutePattern: boolean;
    showZoomControls: boolean;
  }) => {
    const isPlaybackOnly = !showRoutePattern && !showZoomControls;

    return (
      <div className={`simulation-controls ${isPlaybackOnly ? "playback-only" : ""}`}>
        {showRoutePattern && (
          <RoutePatternSwitch
            onChange={selectRoutePattern}
            routePattern={routePattern}
          />
        )}
      {showZoomControls && (
        <ViewZoomControls
          onZoomChange={updateOverheadZoom}
          onZoomIn={zoomOverheadIn}
          onZoomOut={zoomOverheadOut}
          onZoomReset={resetOverheadView}
          zoom={overheadZoom}
        />
      )}
        {playbackControls}
      </div>
    );
  };

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Warehouse location creator</p>
          <h1>Simulator</h1>
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
          configDraft={configDraft}
          generatedLocations={generatedLocations}
          mode={mode}
          onConfigBlur={normalizeConfigDraft}
          onConfigDraftChange={updateConfigDraft}
          onSourceChange={selectMode}
        />
      )}

      {activePage === "overhead" && (
        <div className="simulation-grid">
          <div className="simulation-main">
            <OverheadRoute
              activeIndex={safeActiveIndex}
              controls={simulationControls({
                showRoutePattern: true,
                showZoomControls: true,
              })}
              config={activeConfig}
              onPanChange={setOverheadPan}
              onZoomChange={updateOverheadZoom}
              pan={overheadPan}
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
            <AisleBayInspector
              active={activePick}
              activeIndex={safeActiveIndex}
              controls={simulationControls({
                showRoutePattern: false,
                showZoomControls: false,
              })}
              config={activeConfig}
              locations={selectedBayPickStops}
              onSelectBay={selectBay}
              routePattern={routePattern}
              selectedBay={normalizedSelectedBay}
              speedMs={speedMs}
              viewportSize={viewportSize}
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
