#!/usr/bin/env bash
set -Eeuo pipefail

readonly container_name=1Panel-openresty
readonly expected_image=1panel/openresty:1.31.1.1-0-noble
readonly expected_project=openresty
readonly expected_service=openresty
readonly nginx=/usr/local/openresty/nginx/sbin/nginx

[[ $# == 1 && ( "$1" == test || "$1" == reload ) ]] || {
  printf 'Usage: openresty-control test|reload\n' >&2
  exit 64
}
[[ "$(id -u)" == 0 ]] || { printf 'openresty-control requires root\n' >&2; exit 77; }

mapfile -t matches < <(docker ps --filter "name=^/${container_name}$" --format '{{.ID}}')
[[ ${#matches[@]} == 1 && -n "${matches[0]}" ]] || {
  printf 'Expected exactly one running %s container\n' "$container_name" >&2
  exit 1
}
container_id="${matches[0]}"
[[ "$(docker inspect -f '{{.Name}}' "$container_id")" == "/$container_name" ]]
[[ "$(docker inspect -f '{{.Config.Image}}' "$container_id")" == "$expected_image" ]]
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id")" == "$expected_project" ]]
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")" == "$expected_service" ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$container_id")" == true ]]
docker exec "$container_id" test -x "$nginx"

case "$1" in
  test) docker exec "$container_id" "$nginx" -t ;;
  reload)
    docker exec "$container_id" "$nginx" -t
    docker exec "$container_id" "$nginx" -s reload
    ;;
esac
