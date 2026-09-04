#!/usr/bin/env bash
# Складывает результаты сборки в папку out: сам файл приложения, файл для
# магазина и — если ключ создавался только что — сам ключ.
#
# Использование: tools/android-collect.sh "Название" "true|false"

set -e

NAME="${1:-WolffMsg}"
KEY_CREATED="${2:-false}"

mkdir -p out

APK=$(find android-app/app/build/outputs android/app/build/outputs android \
        -name '*.apk' 2>/dev/null | grep -v unsigned | head -1 || true)
AAB=$(find android-app/app/build/outputs android/app/build/outputs android \
        -name '*.aab' 2>/dev/null | head -1 || true)

if [ -n "$APK" ]; then cp "$APK" "out/$NAME.apk"; else echo "::error::APK не собрался"; exit 1; fi
if [ -n "$AAB" ]; then cp "$AAB" "out/$NAME.aab"; fi

if [ "$KEY_CREATED" = "true" ] && [ -f android.keystore ]; then
    cp android.keystore out/android.keystore
    base64 -w0 android.keystore > out/android.keystore.base64.txt
fi

ls -la out
du -h out/*.apk
