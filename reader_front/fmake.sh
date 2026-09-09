#! /bin/bash
ENV_FILE=~/.env
web_deployment=$(sed -nE 's/^web_deployment[[:space:]]*=[[:space:]]*(.*)$/\1/p' "$ENV_FILE")
clear_destination="${web_deployment}/dl.sh"
"$clear_destination"

#build
ng build --configuration production

#move
mv ./dist/n001-star/browser/* "web_deployment"
