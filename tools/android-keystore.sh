#!/usr/bin/env bash
# Ключ подписи для приложения.
#
# Магазин принимает обновления только с тем же ключом, которым подписана первая
# версия. Поэтому: если ключ уже сохранён в секретах репозитория — берём его,
# иначе создаём новый и отдаём вместе со сборкой, чтобы его сохранили.
#
# Использование: tools/android-keystore.sh "Название приложения"

set -e

NAME="${1:-WolffMsg}"
PASS="${KEYSTORE_PASSWORD:-wolffmsg}"

if [ -n "${KEYSTORE_B64:-}" ]; then
    echo "$KEYSTORE_B64" | base64 -d > android.keystore
    echo "created=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    echo "Использую сохранённый ключ подписи."
else
    keytool -genkeypair -v \
        -keystore android.keystore \
        -alias wolffmsg -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass "$PASS" -keypass "$PASS" \
        -dname "CN=$NAME, OU=WolffMsg, O=WolffMsg, C=RU"
    echo "created=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    echo "::warning::Создан НОВЫЙ ключ подписи. Сохраните android.keystore из результатов сборки и добавьте его в секреты репозитория — без него обновить приложение в магазине будет невозможно."
fi
