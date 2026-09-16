#! /bin/bash
ENV_FILE=~/.env
cms_deployment=$(sed -nE 's/^[[:space:]]*cms_deployment[[:space:]]*=[[:space:]]*"?([^"[:space:]]*)"?.*$/\1/p' "$ENV_FILE" | tail -n1)
clear_destination="${cms_deployment}/dl.sh"
"$clear_destination"

#build
npx ng build --configuration production

#move
mv ./dist/webdeveloper/browser/* "$cms_deployment"
