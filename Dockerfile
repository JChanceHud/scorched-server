FROM alpine:latest
MAINTAINER Chance Hudson

RUN apk add --no-cache nodejs-npm

ENV SCORCHED_ADDRESS=0x55124919a3Eee2FF5b3eB715c02D0EAFB438CcC9
ENV ADJUDICATOR_ADDRESS=0x48ba949F5d6b360C0bbfad8dEE26BD8da8649cf6
ENV RPC_URL=ws://72.182.36.52:9546
ENV DATA_FILEPATH=/data/data.json

COPY . /src

WORKDIR /src

RUN npm ci && npm run build

CMD ["node", "build"]
