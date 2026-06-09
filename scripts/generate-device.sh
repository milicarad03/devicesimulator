#!/bin/bash

if [ -z "$1" ]; then
    echo "Error: You must provide a device ID!"
    echo "Usage: ./generate-device.sh <device_id>"
    echo "Example: ./generate-device.sh device-3"
    exit 1
fi

DEVICE_ID=$1
CA_DIR="./certs/fact"
CERTS_DIR="./certs/$DEVICE_ID"

CA_KEY="$CA_DIR/factory-ca.key"
CA_CRT="$CA_DIR/factory-ca.crt"

if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CRT" ]; then
    echo "Error: Missing factory-ca.key or factory-ca.crt in folder '$CA_DIR'!"
    exit 1
fi

echo "Starting certificate generation for: $DEVICE_ID"

mkdir -p "$CERTS_DIR"

echo "Generating factory-device.key..."
openssl genrsa -out "$CERTS_DIR/factory-device.key" 2048 2>/dev/null

echo "Creating CSR with CN=$DEVICE_ID..."
openssl req -new -key "$CERTS_DIR/factory-device.key" -out "$CERTS_DIR/factory-device.csr" -subj "/CN=$DEVICE_ID" 2>/dev/null

echo "Signing certificate using Factory CA..."
openssl x509 -req -in "$CERTS_DIR/factory-device.csr" \
    -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$CERTS_DIR/factory-device.crt" \
    -days 365 -sha256 2>/dev/null

rm "$CERTS_DIR/factory-device.csr"
if [ -f "$CA_DIR/factory-ca.srl" ]; then
    rm "$CA_DIR/factory-ca.srl"
fi

echo "Successfully created directory and certificates at: $CERTS_DIR/"
ls -l "$CERTS_DIR"