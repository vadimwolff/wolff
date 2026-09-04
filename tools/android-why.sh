#!/usr/bin/env bash
# Достаёт из журнала сборки причину падения и печатает её на страницу сборки —
# туда, где её видно сразу, без раскрытия шагов.

set +e

LOG="${1:-gradle.log}"
OUT="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

{
    echo "## Сборка не удалась"
    echo ""
    echo "Ниже — причина. Скопируйте этот кусок целиком и пришлите."
    echo ""
    echo '```'
} >> "$OUT"

if [ -f "$LOG" ]; then
    # Блок «FAILURE: … What went wrong … Try:» — самое главное.
    awk '/FAILURE: Build failed/,/^\* Get more help/' "$LOG" | head -60 >> "$OUT"

    echo "" >> "$OUT"
    echo "--- последние строки журнала ---" >> "$OUT"
    tail -40 "$LOG" >> "$OUT"
else
    echo "Журнал сборки не создан — сборка упала ещё до запуска Gradle." >> "$OUT"
fi

echo '```' >> "$OUT"
