#!/bin/sh
echo "Waiting for database..."
while ! nc -z rinha-db 5432; do
  sleep 1
done
echo "Database is ready!"

echo "Waiting for redis..."
while ! nc -z rinha-redis 6379; do
  sleep 1
done
echo "Redis is ready!"

echo "Starting application..."
exec "$@"