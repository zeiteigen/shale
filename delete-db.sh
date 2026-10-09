read -p "Are you sure you want to continue? (y/n) " -n 1 -r
echo # Move to a new line

if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    echo "Aborted."
    exit 1
fi


rm "$(dirname "$0")/data/production.db"
rm "$(dirname "$0")/data/production.db-shm"
rm "$(dirname "$0")/data/production.db-wal"