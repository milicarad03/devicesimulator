const fs = require('fs');

function analyzeLogs(fullFile, deltaFile) {
    const fullData = fs.readFileSync(fullFile, 'utf8').trim().split('\n');
    const deltaData = fs.readFileSync(deltaFile, 'utf8').trim().split('\n');

    const calculateAverage = (lines) => {
        let total = 0;
        let count = 0;
        lines.forEach(line => {
            if (line.startsWith('{')) {
                const obj = JSON.parse(line);
                total += obj.size;
                count++;
            } 
            else if (line.includes('|')) {
                const size = parseInt(line.split('|')[1]);
                if (!isNaN(size)) {
                    total += size;
                    count++;
                }
            }
        });
        return { average: total / count, total };
    };

    const full = calculateAverage(fullData);
    const delta = calculateAverage(deltaData);

    const savings = full.average - delta.average;
    const savingsPercentage = (savings / full.average) * 100;

    console.log(`--- SIZE ANALYSIS ---`);
    console.log(`Average FULL size: ${full.average.toFixed(2)} bytes`);
    console.log(`Average DELTA size: ${delta.average.toFixed(2)} bytes`);
    console.log(`-------------------------`);
    console.log(`Average savings per message: ${savings.toFixed(2)} bytes`);
    console.log(`Savings in percentage: ${savingsPercentage.toFixed(2)}%`);
}

console.log("TELEMETRY STATISTICS:");
analyzeLogs('telemetry_stats_full1.log', 'telemetry_stats_delta1.log');

console.log("\nDUMMY TRAFFIC STATISTICS:");
analyzeLogs('dummy_traffic_full_MODELF1.log', 'dummy_traffic_delta_MODELF1.log');