# whisper.cpp's command-line program as ONE file that runs inside the Superstation IPTV image (Alpine Linux) with
# nothing else installed — for "Subtitles made from the sound" (docs/integrations.md).
#
#   docker build --output type=local,dest=./data/whisper tools/whisper
#
# puts whisper-cli in the server's data folder, where the app looks for it. setup-whisper.bat / setup-whisper.sh
# do that and fetch a model file too.
#
# It is built from source here because whisper.cpp publishes no program for Alpine. Linked statically, so it doesn't
# depend on which Alpine the app's image was built from. Built for the processor of the computer it is built on
# (GGML_NATIVE, whisper.cpp's default): build it on the computer that runs the server. No OpenMP: its own threads.
FROM alpine:3 AS build
ARG WHISPER_CPP=v1.9.5
RUN apk add --no-cache build-base cmake git linux-headers
RUN git clone --depth 1 --branch "$WHISPER_CPP" https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DCMAKE_EXE_LINKER_FLAGS=-static \
 && cmake --build build -j "$(nproc)" --target whisper-cli \
 && strip build/bin/whisper-cli \
 && build/bin/whisper-cli --help 2>&1 | grep -q -- -ovtt

# (Only the program: "--output type=local" copies what is in this last stage into a folder.)
FROM scratch
COPY --from=build /src/build/bin/whisper-cli /whisper-cli
