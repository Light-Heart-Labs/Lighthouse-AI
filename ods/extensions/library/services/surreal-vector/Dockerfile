FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
ENV PYTHONUNBUFFERED=1
EXPOSE 6333
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "6333"]
