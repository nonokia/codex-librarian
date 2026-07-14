output "web_instance_ids" {
  description = "IDs of the web instances"
  value       = aws_instance.web[*].id
}

output "database_endpoint" {
  description = "Connection endpoint of the task database"
  value       = aws_db_instance.main.endpoint
}

output "vpc_id" {
  description = "ID of the VPC"
  value       = module.vpc.vpc_id
}
