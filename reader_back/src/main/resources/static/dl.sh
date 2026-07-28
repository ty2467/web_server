#!/bin/bash

# 1. Switch to the directory where this script is located
cd "$(dirname "$0")" || { echo "Failed to change dir"; exit 1; }

# Configuration
prefix1="main-"
prefix2="styles-"

# 2. Senior engineering 'best practice': nullglob
# This prevents the script from trying to move the literal string "prefix*"
# if no matching files are found.
shopt -s nullglob

# 3. Move the files
# The quotes around the variable handle spaces in the prefix;
# the * stays outside the quotes to allow expansion.
echo "deleting '${prefix1}'*  '${prefix2}'* "
rm -f -r "${prefix1}"* "${prefix2}"* index.html