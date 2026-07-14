variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (dev/staging/prod)"
  type        = string
  default     = "dev"
}

variable "app_name" {
  description = "Application name, used as a resource name prefix"
  type        = string
  default     = "taskflow"
}

variable "instance_count" {
  description = "Number of web instances"
  type        = number
  default     = 2
}

variable "db_password" {
  description = "Master password for the task database"
  type        = string
  sensitive   = true
}
