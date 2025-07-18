# Comandos Úteis - Curl e Docker

## Curl Commands

### GET Requests
```bash
# Basic GET request
curl -X GET http://localhost:3000/api/users

# GET with headers
curl -X GET \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  http://localhost:3000/api/users

# GET with query parameters
curl -X GET "http://localhost:3000/api/users?page=1&limit=10"
```

### POST Requests
```bash
# POST with JSON data
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"name": "João", "email": "joao@email.com"}' \
  http://localhost:3000/api/users

# POST with form data
curl -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "name=João&email=joao@email.com" \
  http://localhost:3000/api/users

# POST with file upload
curl -X POST \
  -F "file=@/path/to/file.jpg" \
  -F "description=Profile picture" \
  http://localhost:3000/api/upload
```

### PUT/PATCH Requests
```bash
# PUT request
curl -X PUT \
  -H "Content-Type: application/json" \
  -d '{"name": "João Silva", "email": "joao.silva@email.com"}' \
  http://localhost:3000/api/users/123

# PATCH request
curl -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"name": "João Silva"}' \
  http://localhost:3000/api/users/123
```

### DELETE Requests
```bash
# DELETE request
curl -X DELETE \
  -H "Authorization: Bearer your-token" \
  http://localhost:3000/api/users/123
```

### Debug Options
```bash
# Verbose output
curl -v http://localhost:3000/api/users

# Include response headers
curl -i http://localhost:3000/api/users

# Follow redirects
curl -L http://localhost:3000/api/users

# Set timeout
curl --connect-timeout 30 --max-time 60 http://localhost:3000/api/users
```

## Docker Commands

### Container Logs
```bash
# View logs of a specific container
docker logs container_name

# Follow logs in real-time
docker logs -f container_name

# Show last 100 lines
docker logs --tail 100 container_name

# Show logs with timestamps
docker logs -t container_name

# Show logs from specific time
docker logs --since "2024-01-01T00:00:00Z" container_name
```

### Docker Compose Logs
```bash
# View logs of all services
docker-compose logs

# View logs of specific service
docker-compose logs service_name

# Follow logs in real-time
docker-compose logs -f

# Show last 100 lines for all services
docker-compose logs --tail 100

# Show logs with timestamps
docker-compose logs -t
```

### Redis Queue Monitoring
```bash
# Access Redis CLI inside container
docker exec -it rinha-redis redis-cli

# Check all keys
docker exec -it rinha-redis redis-cli KEYS "*"

# Check queue length
docker exec -it rinha-redis redis-cli LLEN queue_name

# View queue contents (first 10 items)
docker exec -it rinha-redis redis-cli LRANGE queue_name 0 9

# Monitor Redis commands in real-time
docker exec -it rinha-redis redis-cli MONITOR

# Check Redis info
docker exec -it rinha-redis redis-cli INFO

# Check memory usage
docker exec -it rinha-redis redis-cli INFO memory

# Check connected clients
docker exec -it rinha-redis redis-cli CLIENT LIST
```

### Database Logs and Commands
```bash
# PostgreSQL logs
docker-compose logs rinha-db

# Access PostgreSQL CLI
docker exec -it rinha-db psql -U username -d database_name

# Payment processor databases
docker exec -it payment-processor-default-db psql -U username -d database_name
docker exec -it payment-processor-fallback-db psql -U username -d database_name
```

### System Monitoring
```bash
# Check container resource usage
docker stats

# Check specific container stats
docker stats container_name

# Check disk usage
docker system df

# Check container processes
docker exec -it container_name ps aux

# Check container network
docker network ls
docker network inspect network_name
```

### Useful One-liners
```bash
# Stop all containers
docker stop $(docker ps -q)

# Remove all containers
docker rm $(docker ps -aq)

# Remove all images
docker rmi $(docker images -q)

# Clean up system
docker system prune -a

# Check container IP
docker inspect container_name | grep IPAddress

# Copy file from container
docker cp container_name:/path/to/file /local/path

# Copy file to container
docker cp /local/path container_name:/path/to/file
```