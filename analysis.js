const fs = require("fs");
const path = require("path");

const DEFAULT_COMPARISONS = [
  {
    name: "telemetry",
    fullFile: "telemetry_stats_full1.log",
    deltaFile: "telemetry_stats_delta1.log",
  },
  {
    name: "dummy-traffic",
    fullFile: "dummy_traffic_full_MODELF1.log",
    deltaFile: "dummy_traffic_delta_MODELF1.log",
  },
];

const percentile = (sortedValues, percentage) => {
  const index = Math.max(
    0,
    Math.ceil((percentage / 100) * sortedValues.length) - 1,
  );

  return sortedValues[index];
};

const calculateStatistics = (values) => {
  if (values.length === 0) {
    throw new Error("No valid message-size samples were found.");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

  return {
    samples: sorted.length,
    totalBytes: total,
    minimumBytes: sorted[0],
    maximumBytes: sorted[sorted.length - 1],
    averageBytes: total / sorted.length,
    medianBytes: median,
    p95Bytes: percentile(sorted, 95),
  };
};

const parseMessageSizes = (filePath) => {
  const content = fs.readFileSync(filePath, "utf8");
  const values = [];
  let skippedLines = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    let value;

    if (line.startsWith("{")) {
      try {
        value = Number(JSON.parse(line).size);
      } catch {
        skippedLines += 1;
        continue;
      }
    } else if (line.includes("|")) {
      value = Number.parseInt(line.split("|")[1]?.trim(), 10);
    }

    if (!Number.isFinite(value) || value < 0) {
      skippedLines += 1;
      continue;
    }

    values.push(value);
  }

  return {
    statistics: calculateStatistics(values),
    skippedLines,
  };
};

const analyzeLogs = (name, fullFile, deltaFile) => {
  const resolvedFullFile = path.resolve(fullFile);
  const resolvedDeltaFile = path.resolve(deltaFile);
  const full = parseMessageSizes(resolvedFullFile);
  const delta = parseMessageSizes(resolvedDeltaFile);
  const averageSavingsBytes =
    full.statistics.averageBytes - delta.statistics.averageBytes;
  const savingsPercentage =
    full.statistics.averageBytes === 0
      ? 0
      : (averageSavingsBytes / full.statistics.averageBytes) * 100;

  return {
    name,
    files: {
      full: resolvedFullFile,
      delta: resolvedDeltaFile,
    },
    full: {
      ...full.statistics,
      skippedLines: full.skippedLines,
    },
    delta: {
      ...delta.statistics,
      skippedLines: delta.skippedLines,
    },
    savings: {
      averageBytes: averageSavingsBytes,
      percentage: savingsPercentage,
    },
  };
};

const formatNumber = (value) => Number(value.toFixed(2));

const printReport = (report) => {
  console.log(`\n${report.name.toUpperCase()} TELEMETRY SIZE`);
  console.table({
    FULL: {
      samples: report.full.samples,
      average: `${formatNumber(report.full.averageBytes)} B`,
      median: `${formatNumber(report.full.medianBytes)} B`,
      p95: `${formatNumber(report.full.p95Bytes)} B`,
      minimum: `${formatNumber(report.full.minimumBytes)} B`,
      maximum: `${formatNumber(report.full.maximumBytes)} B`,
      skipped: report.full.skippedLines,
    },
    DELTA: {
      samples: report.delta.samples,
      average: `${formatNumber(report.delta.averageBytes)} B`,
      median: `${formatNumber(report.delta.medianBytes)} B`,
      p95: `${formatNumber(report.delta.p95Bytes)} B`,
      minimum: `${formatNumber(report.delta.minimumBytes)} B`,
      maximum: `${formatNumber(report.delta.maximumBytes)} B`,
      skipped: report.delta.skippedLines,
    },
  });
  console.log(
    `Average DELTA savings: ${formatNumber(report.savings.averageBytes)} B ` +
      `(${formatNumber(report.savings.percentage)}%)`,
  );
};

const parseArguments = (args) => {
  const positional = [];
  let outputFile;
  let jsonOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--json") {
      jsonOnly = true;
      continue;
    }

    if (argument === "--output") {
      outputFile = args[index + 1];
      index += 1;

      if (!outputFile) {
        throw new Error("--output requires a file path.");
      }
      continue;
    }

    positional.push(argument);
  }

  if (positional.length !== 0 && positional.length !== 2) {
    throw new Error(
      "Provide either no log paths or exactly FULL_LOG and DELTA_LOG.",
    );
  }

  return { positional, outputFile, jsonOnly };
};

const runAnalysis = (args = process.argv.slice(2)) => {
  const { positional, outputFile, jsonOnly } = parseArguments(args);
  const comparisons =
    positional.length === 2
      ? [
          {
            name: "custom",
            fullFile: positional[0],
            deltaFile: positional[1],
          },
        ]
      : DEFAULT_COMPARISONS.filter(
          ({ fullFile, deltaFile }) =>
            fs.existsSync(path.resolve(fullFile)) &&
            fs.existsSync(path.resolve(deltaFile)),
        );

  if (comparisons.length === 0) {
    throw new Error(
      "No complete FULL/DELTA log pair was found in the current directory.",
    );
  }

  const result = {
    generatedAt: new Date().toISOString(),
    workingDirectory: process.cwd(),
    comparisons: comparisons.map(({ name, fullFile, deltaFile }) =>
      analyzeLogs(name, fullFile, deltaFile),
    ),
  };

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    result.comparisons.forEach(printReport);
  }

  if (outputFile) {
    const resolvedOutput = path.resolve(outputFile);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, `${JSON.stringify(result, null, 2)}\n`);

    if (!jsonOnly) {
      console.log(`\nSaved JSON report: ${resolvedOutput}`);
    }
  }

  return result;
};

if (require.main === module) {
  try {
    runAnalysis();
  } catch (error) {
    console.error(`[analysis] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  analyzeLogs,
  calculateStatistics,
  parseMessageSizes,
  runAnalysis,
};
