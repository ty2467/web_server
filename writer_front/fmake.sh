#! /bin/bash
ENV_FILE=~/.env
cms_deployment=$(sed -nE 's/^cms_deployment[[:space:]]*=[[:space:]]*(.*)$/\1/p' "$ENV_FILE")
clear_destination="${cms_deployment}/dl.sh"
"$clear_destination"

#build
ng build --configuration production

#move
mv ./dist/webdeveloper/browser/* "cms_deployment"
