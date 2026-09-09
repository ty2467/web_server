#! /bin/bash
ENV_FILE=~/.env
web_deployment=$(sed -nE 's/^[[:space:]]*web_deployment[[:space:]]*=[[:space:]]*"?([^"[:space:]]*)"?.*$/\1/p' "$ENV_FILE" | tail -n1)
clear_destination="${web_deployment}/dl.sh"
"$clear_destination"

#build
npx ng build --configuration production

#move
mv ./dist/n001-star/browser/* "web_deployment"
