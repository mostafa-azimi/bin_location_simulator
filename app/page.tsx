"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";

type RouteSide = "left" | "right";
type PageKey = "create" | "overhead" | "aisle" | "output";
type SourceMode = "generated" | "uploaded";
type RoutePattern = "serpentine" | "u-shape";

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

const defaultConfig: LayoutConfig = {
  zones: 1,
  aisles: 3,
  bays: 8,
  shelves: 3,
  slots: 4,
};

const inputLimits: Record<keyof LayoutConfig, number> = {
  zones: 6,
  aisles: 24,
  bays: 48,
  shelves: 8,
  slots: 12,
};

const labels: Record<keyof LayoutConfig, string> = {
  zones: "Zones",
  aisles: "Aisles",
  bays: "Bays per aisle",
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

function bayRouteKey(location: LocationRecord) {
  return `${location.zoneIndex}-${location.aisle}-${location.bay}`;
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

function buildHighlightedStops(locations: LocationRecord[]) {
  const seenBays = new Set<string>();

  return locations.filter((location) => {
    const key = bayRouteKey(location);

    if (seenBays.has(key)) {
      return false;
    }

    seenBays.add(key);
    return true;
  });
}

function flipSide(side: RouteSide): RouteSide {
  return side === "left" ? "right" : "left";
}

function routeSideForPattern(
  location: LocationRecord,
  config: LayoutConfig,
  routePattern: RoutePattern,
): RouteSide {
  if (routePattern === "u-shape") {
    return location.bay <= Math.ceil(config.bays / 2) ? "left" : "right";
  }

  return location.side;
}

function screenSideForOverhead(
  location: LocationRecord,
  config: LayoutConfig,
  routePattern: RoutePattern,
  aisleDirection: "up" | "down",
) {
  const pickerSide = routeSideForPattern(location, config, routePattern);

  if (routePattern === "serpentine" && aisleDirection === "down") {
    return flipSide(pickerSide);
  }

  return pickerSide;
}

function buildOverheadRows(
  config: LayoutConfig,
  routePattern: RoutePattern,
  aisleDirection: "up" | "down",
) {
  if (routePattern === "u-shape") {
    const leftSideCount = Math.ceil(config.bays / 2);

    return Array.from({ length: leftSideCount }, (_, index) => ({
      leftBay: leftSideCount - index,
      rightBay:
        leftSideCount + index + 1 <= config.bays
          ? leftSideCount + index + 1
          : null,
    }));
  }

  const pairs = Array.from({ length: Math.ceil(config.bays / 2) }, (_, index) => ({
    odd: index * 2 + 1,
    even: index * 2 + 2 <= config.bays ? index * 2 + 2 : null,
  }));
  const physicalPairs = aisleDirection === "up" ? [...pairs].reverse() : pairs;

  return physicalPairs.map(({ odd, even }) => ({
    leftBay: aisleDirection === "up" ? odd : even,
    rightBay: aisleDirection === "up" ? even : odd,
  }));
}

function generateLocations(config: LayoutConfig) {
  const locations: LocationRecord[] = [];

  for (let zone = 1; zone <= config.zones; zone += 1) {
    for (let aisle = 1; aisle <= config.aisles; aisle += 1) {
      for (let bay = 1; bay <= config.bays; bay += 1) {
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
      bays: Math.max(max.bays, record.bay),
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
    <section className="panel route-pattern-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Route path</p>
          <h2>{routePatternLabels[routePattern]}</h2>
        </div>
      </div>
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
    </section>
  );
}

function PlaybackControls({
  active,
  activeIndex,
  total,
  isPlaying,
  speedMs,
  onPrevious,
  onNext,
  onPlayPause,
  onSeek,
  onSpeedChange,
}: {
  active: LocationRecord | undefined;
  activeIndex: number;
  total: number;
  isPlaying: boolean;
  speedMs: number;
  onPrevious: () => void;
  onNext: () => void;
  onPlayPause: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speedMs: number) => void;
}) {
  return (
    <section className="panel playback-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Replay</p>
          <h2>{active?.name ?? "No active location"}</h2>
        </div>
        <span className="small-badge">{total ? `${activeIndex + 1} / ${total}` : "0 / 0"}</span>
      </div>

      <div className="playback-row">
        <button className="ghost-action" onClick={onPrevious} type="button">
          Previous
        </button>
        <button className="primary-action compact" onClick={onPlayPause} type="button">
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button className="ghost-action" onClick={onNext} type="button">
          Next
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
    </section>
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
  locations,
  activeIndex,
  active,
  config,
  routePattern,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  active: LocationRecord | undefined;
  config: LayoutConfig;
  routePattern: RoutePattern;
}) {
  const activeZoneIndex = active?.zoneIndex ?? 1;
  const activeZone = active?.zoneLabel ?? "01";
  const stopIndexByBay = useMemo(() => {
    const steps = new Map<string, number>();

    locations.forEach((location, index) => {
      if (location.zoneIndex !== activeZoneIndex) {
        return;
      }

      steps.set(`${location.aisle}-${location.bay}`, index);
    });

    return steps;
  }, [activeZoneIndex, locations]);

  const aisles = Array.from({ length: config.aisles }, (_, index) => index + 1);

  const bayClassName = (aisle: number, bay: number) => {
    const step = stopIndexByBay.get(`${aisle}-${bay}`);
    const isActive = active?.aisle === aisle && active.bay === bay;
    const isPlanned = typeof step === "number";
    const isDone = typeof step === "number" && activeIndex > step;

    return `warehouse-bay ${isPlanned ? "planned" : ""} ${
      isActive ? "active" : ""
    } ${isDone ? "done" : ""}`;
  };
  const renderBay = (aisle: number, bay: number | null) =>
    bay && bay <= config.bays ? (
      <div className={bayClassName(aisle, bay)}>
        <span>Bay {pad2(bay)}</span>
      </div>
    ) : (
      <div className="warehouse-bay empty" />
    );

  return (
    <section className="panel visualization-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Overhead simulation</p>
          <h2>Zone {activeZone}</h2>
        </div>
        <span className="small-badge">{routePatternLabels[routePattern]} path</span>
      </div>

      <div className="warehouse-scroll">
        <div className="warehouse-outline route-outline">
          <div
            className="route-grid"
            style={{ gridTemplateColumns: `repeat(${config.aisles}, minmax(164px, 1fr))` }}
          >
            {aisles.map((aisle) => {
              const aisleLabel = lettersFromNumber(aisle);
              const direction =
                routePattern === "serpentine" && aisle % 2 === 0 ? "down" : "up";
              const rows = buildOverheadRows(config, routePattern, direction);

              return (
                <div
                  className={`warehouse-aisle route-aisle ${routePattern} ${direction}`}
                  key={aisle}
                >
                  <div className="aisle-track-label">
                    <strong>{activeZone}{aisleLabel}</strong>
                    <span>Aisle {aisleLabel}</span>
                  </div>

                  <div
                    className="route-bay-stack"
                    style={{ gridTemplateRows: `repeat(${rows.length}, minmax(72px, 1fr))` }}
                  >
                    {rows.map(({ leftBay, rightBay }) => {
                      const rowBays = [leftBay, rightBay].filter(
                        (bay): bay is number => Boolean(bay),
                      );
                      const plannedSteps = rowBays
                        .map((bay) => stopIndexByBay.get(`${aisle}-${bay}`))
                        .filter(
                        (step): step is number => typeof step === "number",
                      );
                      const isActivePair =
                        active?.aisle === aisle && rowBays.includes(active.bay);
                      const isDonePair =
                        plannedSteps.length > 0 &&
                        plannedSteps.every((step) => activeIndex > step);
                      const trackDirection =
                        routePattern === "u-shape" && isActivePair && active
                          ? routeSideForPattern(active, config, routePattern) === "left"
                            ? "up"
                            : "down"
                          : routePattern === "u-shape"
                            ? "u-path"
                            : direction;
                      const tetherSide =
                        active && isActivePair
                          ? screenSideForOverhead(active, config, routePattern, direction)
                          : "left";

                      return (
                        <div
                          className={`route-pair ${isActivePair ? "active-pair" : ""}`}
                          key={`${aisle}-${leftBay ?? "empty"}-${rightBay ?? "empty"}`}
                        >
                          {renderBay(aisle, leftBay)}
                          <div
                            className={`aisle-track ${trackDirection} ${
                              isActivePair ? "active" : ""
                            } ${isDonePair ? "done" : ""}`}
                          >
                            {isActivePair && (
                              <>
                                <div className={`pick-tether ${tetherSide}`} />
                                <div className="overhead-picker">
                                  <span>Picker</span>
                                </div>
                              </>
                            )}
                          </div>
                          {renderBay(aisle, rightBay)}
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
  const slots = Array.from({ length: config.slots }, (_, index) => index + 1);

  return (
    <div className={`rack-bay ${bay === active?.bay ? "active-bay" : ""}`}>
      <div className="rack-title">
        <span>{bay ? `Bay ${pad2(bay)}` : "No bay"}</span>
        <strong>{sideLabel}</strong>
      </div>
      <div className="shelf-stack">
        {shelves.map((shelf) => (
          <div className="shelf-row" key={`${bay}-${shelf}`}>
            <span className="shelf-label">{lettersFromNumber(shelf)}</span>
            <div
              className="slot-grid"
              style={{ gridTemplateColumns: `repeat(${config.slots}, minmax(34px, 1fr))` }}
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
}

function AislePickView({
  locations,
  activeIndex,
  active,
  config,
  routePattern,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  active: LocationRecord | undefined;
  config: LayoutConfig;
  routePattern: RoutePattern;
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

  const splitBay = Math.ceil(config.bays / 2);
  const activeRouteSide = active
    ? routeSideForPattern(active, config, routePattern)
    : "left";
  let leftBays: number[] = [];
  let rightBays: number[] = [];

  if (routePattern === "u-shape") {
    const activeRow = active
      ? activeRouteSide === "left"
        ? active.bay - 1
        : config.bays - active.bay
      : 0;
    const baseRow = Math.max(0, Math.min(activeRow, Math.max(0, splitBay - 2)));
    const visibleRows = [baseRow, Math.min(splitBay - 1, baseRow + 1)];

    leftBays = visibleRows.map((row) => row + 1).filter((bay) => bay <= splitBay);
    rightBays = visibleRows
      .map((row) => config.bays - row)
      .filter((bay) => bay > splitBay && bay <= config.bays);
  } else {
    const pairCount = Math.ceil(config.bays / 2);
    const activePair = active ? Math.floor((active.bay - 1) / 2) : 0;
    const basePair = Math.max(0, Math.min(activePair, Math.max(0, pairCount - 2)));
    const visiblePairs = [basePair, Math.min(pairCount - 1, basePair + 1)];

    leftBays = visiblePairs.map((pair) => pair * 2 + 1).filter((bay) => bay <= config.bays);
    rightBays = visiblePairs.map((pair) => pair * 2 + 2).filter((bay) => bay <= config.bays);
  }

  return (
    <section className="panel visualization-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Aisle simulation</p>
          <h2>{active ? `${active.zoneLabel}${active.aisleLabel}` : "No location"}</h2>
        </div>
        <span className="small-badge">
          {routePatternLabels[routePattern]}: {active?.name ?? "No active pick"}
        </span>
      </div>

      <div className="aisle-window">
        <div className="rack-bank left-bank">
          <div className="bank-label">
            {routePattern === "u-shape" ? "Left side, sequential bays" : "Left side, odd bays"}
          </div>
          <div className="rack-bay-row">
            {leftBays.map((bay) => (
              <RackBay
                active={active}
                activeIndex={activeIndex}
                bay={bay}
                config={config}
                indexByName={indexByName}
                key={bay}
                sideLabel="left"
              />
            ))}
          </div>
        </div>

        <div className="picker-lane">
          <div className={`picker-reach ${activeRouteSide}`} />
          <div className="picker-marker">
            <span>Picker</span>
          </div>
          <div className="lane-line" />
        </div>

        <div className="rack-bank right-bank">
          <div className="bank-label">
            {routePattern === "u-shape" ? "Right side, return bays" : "Right side, even bays"}
          </div>
          <div className="rack-bay-row">
            {rightBays.map((bay) => (
              <RackBay
                active={active}
                activeIndex={activeIndex}
                bay={bay}
                config={config}
                indexByName={indexByName}
                key={bay}
                sideLabel="right"
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RouteTimeline({
  locations,
  activeIndex,
  config,
  routePattern,
  onSelect,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  config: LayoutConfig;
  routePattern: RoutePattern;
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
              <span>{routeIndex + 1}</span>
              <strong>{location.name}</strong>
              <em>{routeSideForPattern(location, config, routePattern)}</em>
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
  const [activeIndex, setActiveIndex] = useState(0);
  const [speedMs, setSpeedMs] = useState(600);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysis, setAnalysis] = useState<UploadAnalysis | null>(null);
  const [mode, setMode] = useState<SourceMode>("generated");
  const [routePattern, setRoutePattern] = useState<RoutePattern>("serpentine");

  const generatedLocations = useMemo(() => generateLocations(config), [config]);
  const uploadedLocations = analysis?.validLocations ?? [];
  const activeLocations =
    mode === "uploaded" && uploadedLocations.length > 0
      ? uploadedLocations
      : generatedLocations;
  const routeStops = useMemo(
    () => buildHighlightedStops(activeLocations),
    [activeLocations],
  );
  const activeConfig =
    mode === "uploaded" && uploadedLocations.length > 0
      ? analysis?.inferredConfig ?? config
      : config;
  const safeActiveIndex = Math.min(
    activeIndex,
    Math.max(0, routeStops.length - 1),
  );
  const active = routeStops[safeActiveIndex];
  const csv = useMemo(() => buildShipHeroCsv(activeLocations), [activeLocations]);
  const canUseUploaded = uploadedLocations.length > 0;

  useEffect(() => {
    if (!isPlaying || routeStops.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveIndex((current) => {
        if (current >= routeStops.length - 1) {
          window.clearInterval(timer);
          setIsPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, speedMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, routeStops.length, speedMs]);

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
      active={active}
      activeIndex={safeActiveIndex}
      isPlaying={isPlaying}
      onNext={() =>
        setActiveIndex(() =>
          Math.min(Math.max(0, routeStops.length - 1), safeActiveIndex + 1),
        )
      }
      onPlayPause={() => setIsPlaying((playing) => !playing)}
      onPrevious={() => setActiveIndex(() => Math.max(0, safeActiveIndex - 1))}
      onSeek={setActiveIndex}
      onSpeedChange={setSpeedMs}
      speedMs={speedMs}
      total={routeStops.length}
    />
  );
  const simulationControls = (
    <>
      <RoutePatternSwitch
        onChange={selectRoutePattern}
        routePattern={routePattern}
      />
      {playbackControls}
    </>
  );

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">ShipHero bin planning</p>
          <h1>Bin route simulator</h1>
        </div>
        <PageTabs activePage={activePage} onChange={setActivePage} />
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
              active={active}
              activeIndex={safeActiveIndex}
              config={activeConfig}
              locations={routeStops}
              routePattern={routePattern}
            />
            <RouteTimeline
              activeIndex={safeActiveIndex}
              config={activeConfig}
              locations={routeStops}
              routePattern={routePattern}
              onSelect={setActiveIndex}
            />
          </div>
          <aside className="simulation-side">{simulationControls}</aside>
        </div>
      )}

      {activePage === "aisle" && (
        <div className="simulation-grid">
          <div className="simulation-main">
            <AislePickView
              active={active}
              activeIndex={safeActiveIndex}
              config={activeConfig}
              locations={routeStops}
              routePattern={routePattern}
            />
            <RouteTimeline
              activeIndex={safeActiveIndex}
              config={activeConfig}
              locations={routeStops}
              routePattern={routePattern}
              onSelect={setActiveIndex}
            />
          </div>
          <aside className="simulation-side">{simulationControls}</aside>
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
