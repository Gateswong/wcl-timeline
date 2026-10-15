# Build the Angular frontend (served by the API under /wcl-timeline/)
FROM node:24-alpine AS web
WORKDIR /src/web
COPY src/web/package*.json ./
RUN npm ci
COPY src/web ./
# angular.json writes to ../Api/wwwroot
RUN npx ng build --base-href /wcl-timeline/

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /src
COPY src/Api src/Api
COPY --from=web /src/Api/wwwroot src/Api/wwwroot
RUN dotnet publish src/Api -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /out .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Api.dll"]
